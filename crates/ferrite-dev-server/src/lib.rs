use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use ferrite_client_bundler::{
    ClientBundle, ClientBundleError, ClientBundleOptions, ClientBundleRequest, ClientBundler,
    fingerprint_client_bundle,
};
use ferrite_page_renderer::{
    DocumentRenderOptions, PageMetadata, PageRenderError, PageRenderer, RouteConventions,
    ServerActionManifest,
};
use ferrite_protocol::{
    SERVER_ACTION_REQUEST_MARKER, SERVER_ACTION_REQUEST_VERSION,
    SERVER_PAYLOAD_STREAM_FRAME_MARKER, SERVER_PAYLOAD_STREAM_FRAME_VERSION, ServerActionFormValue,
    ServerActionRequest,
};
use ferrite_router::{Route, RouteParamKind, find_document_file, scan_app_dir, write_route_types};
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
const SERVER_ACTION_PATH: &str = "/_ferrite/action";
const SERVER_ACTION_ID_FIELD: &str = "__ferrite_action";
const SERVER_ACTION_ROUTE_FIELD: &str = "__ferrite_route";
const SERVER_ACTION_RESPONSE_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_PRODUCTION_REQUEST_READ_TIMEOUT: Duration = Duration::from_millis(1);
const DEFAULT_PRODUCTION_RENDER_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_PRODUCTION_RENDER_TIMEOUT: Duration = Duration::from_millis(1);
const DEFAULT_PRODUCTION_MAX_REQUEST_BYTES: usize = 16 * 1024;
const DEFAULT_DEV_MAX_REQUEST_BYTES: usize = DEFAULT_PRODUCTION_MAX_REQUEST_BYTES;
const DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS: usize = 64;
const PRODUCTION_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug)]
pub enum DevServerError {
    Router(ferrite_router::RouterError),
    PageRender(PageRenderError),
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidRequestPath(String),
    NoSocketAddress,
}

impl fmt::Display for DevServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DevServerError::Router(error) => write!(f, "{error}"),
            DevServerError::PageRender(error) => write!(f, "{error}"),
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

impl From<PageRenderError> for DevServerError {
    fn from(error: PageRenderError) -> Self {
        DevServerError::PageRender(error)
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
pub type HttpHeaders = BTreeMap<String, String>;

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
pub struct ProductionShutdownController {
    shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct ProductionShutdownSignal {
    shutdown: Arc<AtomicBool>,
}

impl ProductionShutdownController {
    pub fn new_pair() -> (Self, ProductionShutdownSignal) {
        let shutdown = Arc::new(AtomicBool::new(false));
        (
            Self {
                shutdown: Arc::clone(&shutdown),
            },
            ProductionShutdownSignal { shutdown },
        )
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }

    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }
}

impl ProductionShutdownSignal {
    pub fn never() -> Self {
        Self {
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionRequestEvent {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub route_pattern: Option<String>,
    pub elapsed: Duration,
}

#[derive(Clone)]
pub struct ProductionRequestObserver {
    observe: Arc<dyn Fn(ProductionRequestEvent) + Send + Sync>,
}

impl ProductionRequestObserver {
    pub fn new<F>(observe: F) -> Self
    where
        F: Fn(ProductionRequestEvent) + Send + Sync + 'static,
    {
        Self {
            observe: Arc::new(observe),
        }
    }

    fn observe(&self, event: ProductionRequestEvent) {
        (self.observe)(event);
    }
}

impl fmt::Debug for ProductionRequestObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProductionRequestObserver")
            .finish_non_exhaustive()
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
    pub request_read_timeout: Duration,
    pub render_timeout: Duration,
    pub max_request_bytes: usize,
    pub max_in_flight_requests: usize,
    pub request_observer: Option<ProductionRequestObserver>,
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
            request_read_timeout: DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT,
            render_timeout: DEFAULT_PRODUCTION_RENDER_TIMEOUT,
            max_request_bytes: DEFAULT_PRODUCTION_MAX_REQUEST_BYTES,
            max_in_flight_requests: DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS,
            request_observer: None,
        }
    }

    pub fn with_request_read_timeout(mut self, timeout: Duration) -> Self {
        self.request_read_timeout = timeout.max(MIN_PRODUCTION_REQUEST_READ_TIMEOUT);
        self
    }

    pub fn with_max_request_bytes(mut self, bytes: usize) -> Self {
        self.max_request_bytes = bytes.max(1);
        self
    }

    pub fn with_max_in_flight_requests(mut self, requests: usize) -> Self {
        self.max_in_flight_requests = requests.max(1);
        self
    }

    pub fn with_render_timeout(mut self, timeout: Duration) -> Self {
        self.render_timeout = timeout.max(MIN_PRODUCTION_RENDER_TIMEOUT);
        self
    }

    pub fn with_request_observer<F>(mut self, observer: F) -> Self
    where
        F: Fn(ProductionRequestEvent) + Send + Sync + 'static,
    {
        self.request_observer = Some(ProductionRequestObserver::new(observer));
        self
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

    pub fn handle_post(
        &mut self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
    ) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        self.ensure_fresh()?;
        let path = strip_query(raw_path);
        if path != SERVER_ACTION_PATH {
            return Ok(DevResponse::method_not_allowed());
        }

        self.action_response(headers, body)
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
        let server_action_manifests = self.collect_server_action_manifests(&snapshot.routes)?;
        let body = serde_json::to_string_pretty(&BuildManifest {
            build_id: self.build_id,
            routes: &snapshot.routes,
            server_action_manifests: &server_action_manifests,
        })?;
        Ok(DevResponse::ok("application/json; charset=utf-8", body))
    }

    fn collect_server_action_manifests(
        &self,
        routes: &[Route],
    ) -> Result<Vec<ServerActionManifest>> {
        let renderer = PageRenderer::new(
            self.config.project.clone(),
            self.config.page_renderer.clone(),
        );
        let mut manifests = Vec::new();

        for route in routes {
            let params = representative_route_params(route);
            let manifest = renderer.collect_server_actions(
                &route.file,
                &route.layouts,
                &params,
                &route_conventions(route),
            )?;
            if !manifest.actions.is_empty() {
                manifests.push(manifest);
            }
        }

        Ok(manifests)
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

    fn action_response(&self, headers: &HttpHeaders, body: &[u8]) -> Result<DevResponse> {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");
        let request = match server_action_request_from_form(headers, body) {
            Ok(request) => request,
            Err(response) => return Ok(*response),
        };
        let route_path = request.route_path.clone();
        let Some(match_result) = match_route(&route_path, &snapshot.routes) else {
            return Ok(DevResponse::not_found_text(format!(
                "No Ferrite route matched server action route `{route_path}`"
            )));
        };
        let renderer = PageRenderer::new(
            self.config.project.clone(),
            self.config.page_renderer.clone(),
        );
        let conventions = route_conventions(&match_result.route);

        match renderer.invoke_server_action(
            &match_result.route.file,
            &match_result.route.layouts,
            &match_result.params,
            &conventions,
            &request,
        ) {
            Ok(response) => server_action_json_response(response)
                .map(|response| response.with_route_pattern(match_result.route.path.clone())),
            Err(error) if is_unknown_server_action_error(&error) => {
                Ok(DevResponse::not_found_text(format!(
                    "No Ferrite server action `{}` was registered for `{}`",
                    request.id, route_path
                )))
            }
            Err(error) => Ok(DevResponse::internal_error(render_render_error(
                self.build_id,
                &route_path,
                &match_result,
                &error,
            ))),
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
                    let action_bootstrap =
                        match route_needs_action_bootstrap(renderer, match_result, conventions) {
                            Ok(action_bootstrap) => action_bootstrap,
                            Err(error) => {
                                return DevResponse::internal_error(render_render_error(
                                    self.build_id,
                                    path,
                                    match_result,
                                    &error,
                                ));
                            }
                        };
                    match bundler.bundle_route_request(ClientBundleRequest {
                        page_file: &match_result.route.file,
                        layouts: &match_result.route.layouts,
                        route_path: &match_result.route.path,
                        params: &match_result.params,
                        out_dir: &self.config.client_out_dir,
                        public_path: &self.config.client_public_path,
                        options: ClientBundleOptions { action_bootstrap },
                    }) {
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
                                    preload_scripts: Vec::new(),
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
                        let action_bootstrap =
                            match route_needs_action_bootstrap(renderer, match_result, conventions)
                            {
                                Ok(action_bootstrap) => action_bootstrap,
                                Err(error) => {
                                    return DevResponse::internal_error(render_render_error(
                                        self.build_id,
                                        path,
                                        match_result,
                                        &error,
                                    ));
                                }
                            };
                        match bundler.bundle_route_request(ClientBundleRequest {
                            page_file: &match_result.route.file,
                            layouts: &match_result.route.layouts,
                            route_path: &match_result.route.path,
                            params: &match_result.params,
                            out_dir: &self.config.client_out_dir,
                            public_path: &self.config.client_public_path,
                            options: ClientBundleOptions { action_bootstrap },
                        }) {
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
                    let action_bootstrap =
                        match route_needs_action_bootstrap(renderer, match_result, conventions) {
                            Ok(action_bootstrap) => action_bootstrap,
                            Err(error) => {
                                return DevResponse::internal_error(render_render_error(
                                    self.build_id,
                                    path,
                                    match_result,
                                    &error,
                                ));
                            }
                        };
                    match bundler.bundle_route_request(ClientBundleRequest {
                        page_file: &match_result.route.file,
                        layouts: &match_result.route.layouts,
                        route_path: &match_result.route.path,
                        params: &match_result.params,
                        out_dir: &self.config.client_out_dir,
                        public_path: &self.config.client_public_path,
                        options: ClientBundleOptions { action_bootstrap },
                    }) {
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
                                    preload_scripts: Vec::new(),
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

        let started = Instant::now();
        let response = self.handle_get_inner(raw_path)?;
        self.observe_request("GET", raw_path, &response, started.elapsed());
        Ok(response)
    }

    pub fn handle_post(
        &mut self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
    ) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        let started = Instant::now();
        let response = self.handle_post_inner(raw_path, headers, body)?;
        self.observe_request("POST", raw_path, &response, started.elapsed());
        Ok(response)
    }

    fn handle_get_inner(&mut self, raw_path: &str) -> Result<DevResponse> {
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

    fn handle_post_inner(
        &mut self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
    ) -> Result<DevResponse> {
        self.ensure_ready()?;
        let path = strip_query(raw_path);
        if path != SERVER_ACTION_PATH {
            return Ok(DevResponse::method_not_allowed().with_cache_control("no-store"));
        }

        self.action_response(headers, body)
            .map(|response| response.with_cache_control("no-store"))
    }

    fn observe_request(
        &self,
        method: impl Into<String>,
        path: impl Into<String>,
        response: &DevResponse,
        elapsed: Duration,
    ) {
        if let Some(observer) = &self.config.request_observer {
            observer.observe(ProductionRequestEvent {
                method: method.into(),
                path: path.into(),
                status: response.status,
                route_pattern: response.route_pattern_header.clone(),
                elapsed,
            });
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
            )
            .with_command_timeout(self.config.render_timeout);
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

    fn action_response(&self, headers: &HttpHeaders, body: &[u8]) -> Result<DevResponse> {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");
        let request = match server_action_request_from_form(headers, body) {
            Ok(request) => request,
            Err(response) => return Ok(*response),
        };
        let route_path = request.route_path.clone();
        let Some(match_result) = match_route(&route_path, &snapshot.routes) else {
            return Ok(DevResponse::not_found_text(format!(
                "No Ferrite route matched server action route `{route_path}`"
            )));
        };
        let renderer = PageRenderer::new(
            self.config.project.clone(),
            self.config.page_renderer.clone(),
        )
        .with_command_timeout(self.config.render_timeout);
        let conventions = route_conventions(&match_result.route);

        match renderer.invoke_server_action(
            &match_result.route.file,
            &match_result.route.layouts,
            &match_result.params,
            &conventions,
            &request,
        ) {
            Ok(response) => server_action_json_response(response)
                .map(|response| response.with_route_pattern(match_result.route.path.clone())),
            Err(error) if is_unknown_server_action_error(&error) => {
                Ok(DevResponse::not_found_text(format!(
                    "No Ferrite server action `{}` was registered for `{}`",
                    request.id, route_path
                )))
            }
            Err(error) => Ok(production_render_error_response(
                &route_path,
                &match_result,
                &error,
            )),
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
                        let action_bootstrap =
                            match route_needs_action_bootstrap(renderer, match_result, conventions)
                            {
                                Ok(action_bootstrap) => action_bootstrap,
                                Err(error) => {
                                    return production_render_error_response(
                                        path,
                                        match_result,
                                        &error,
                                    );
                                }
                            };
                        match production_client_bundle(
                            &bundler,
                            ClientBundleRequest {
                                page_file: &match_result.route.file,
                                layouts: &match_result.route.layouts,
                                route_path: &match_result.route.path,
                                params: &match_result.params,
                                out_dir: &self.config.client_out_dir,
                                public_path: &self.config.client_public_path,
                                options: ClientBundleOptions { action_bootstrap },
                            },
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
                                        preload_scripts: client_bundle_scripts(&client_bundle),
                                        styles: client_bundle_styles(&client_bundle),
                                        scripts: client_bundle_scripts(&client_bundle),
                                        default_title: "Ferrite".to_owned(),
                                    },
                                    conventions,
                                ) {
                                Ok(parts) => DevResponse::streaming_html(
                                    parts.shell,
                                    parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                                )
                                .with_modulepreload_links(client_bundle_scripts(&client_bundle)),
                                Err(error) => {
                                    production_render_error_response(path, match_result, &error)
                                }
                            },
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => production_render_error_response(path, match_result, &error),
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
                        let action_bootstrap =
                            match route_needs_action_bootstrap(renderer, match_result, conventions)
                            {
                                Ok(action_bootstrap) => action_bootstrap,
                                Err(error) => {
                                    return production_render_error_response(
                                        path,
                                        match_result,
                                        &error,
                                    );
                                }
                            };
                        match production_client_bundle(
                            &bundler,
                            ClientBundleRequest {
                                page_file: &match_result.route.file,
                                layouts: &match_result.route.layouts,
                                route_path: &match_result.route.path,
                                params: &match_result.params,
                                out_dir: &self.config.client_out_dir,
                                public_path: &self.config.client_public_path,
                                options: ClientBundleOptions { action_bootstrap },
                            },
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
                                .with_modulepreload_links(client_bundle_scripts(&client_bundle))
                            }
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => production_render_error_response(path, match_result, &error),
                },
                Err(error) => production_render_error_response(path, match_result, &error),
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
                        let action_bootstrap =
                            match route_needs_action_bootstrap(renderer, match_result, conventions)
                            {
                                Ok(action_bootstrap) => action_bootstrap,
                                Err(error) => {
                                    return production_render_error_response(
                                        path,
                                        match_result,
                                        &error,
                                    );
                                }
                            };
                        match production_client_bundle(
                            &bundler,
                            ClientBundleRequest {
                                page_file: &match_result.route.file,
                                layouts: &match_result.route.layouts,
                                route_path: &match_result.route.path,
                                params: &match_result.params,
                                out_dir: &self.config.client_out_dir,
                                public_path: &self.config.client_public_path,
                                options: ClientBundleOptions { action_bootstrap },
                            },
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
                                        preload_scripts: client_bundle_scripts(&client_bundle),
                                        styles: client_bundle_styles(&client_bundle),
                                        scripts: client_bundle_scripts(&client_bundle),
                                        default_title: "Ferrite".to_owned(),
                                    },
                                    conventions,
                                ) {
                                Ok(payload) => server_payload_response(payload, response_kind),
                                Err(error) => {
                                    production_render_error_response(path, match_result, &error)
                                }
                            },
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => production_render_error_response(path, match_result, &error),
                }
            }
            None => match renderer.render_page_to_server_payload_json_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(payload) => server_payload_response(payload, response_kind),
                Err(error) => production_render_error_response(path, match_result, &error),
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
    pub link_headers: Vec<String>,
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
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
        }
    }

    pub fn not_found_text(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            reason: "Not Found",
            content_type: "text/plain; charset=utf-8",
            body: format!("Not Found: {}\n", message.into()).into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: 403,
            reason: "Forbidden",
            content_type: "text/plain; charset=utf-8",
            body: format!("Forbidden: {}\n", message.into()).into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
            link_headers: Vec::new(),
        }
    }

    pub fn request_timeout() -> Self {
        Self {
            status: 408,
            reason: "Request Timeout",
            content_type: "text/plain; charset=utf-8",
            body: b"Request Timeout\n".to_vec(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
            link_headers: Vec::new(),
        }
    }

    pub fn payload_too_large() -> Self {
        Self {
            status: 413,
            reason: "Payload Too Large",
            content_type: "text/plain; charset=utf-8",
            body: b"Payload Too Large\n".to_vec(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
            link_headers: Vec::new(),
        }
    }

    pub fn gateway_timeout(body: String) -> Self {
        Self {
            status: 504,
            reason: "Gateway Timeout",
            content_type: "text/html; charset=utf-8",
            body: body.into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
            link_headers: Vec::new(),
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
            link_headers: Vec::new(),
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

    pub fn with_modulepreload_links(mut self, scripts: Vec<String>) -> Self {
        self.link_headers.extend(
            scripts
                .into_iter()
                .map(|script| format!("<{script}>; rel=modulepreload; as=script")),
        );
        self
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug)]
struct ProductionWorkerPool {
    sender: mpsc::Sender<TcpStream>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl ProductionWorkerPool {
    fn new(worker_count: usize, project: Arc<Mutex<ProductionProject>>) -> Self {
        let worker_count = worker_count.max(1);
        let (sender, receiver) = mpsc::channel::<TcpStream>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let receiver = Arc::clone(&receiver);
            let project = Arc::clone(&project);
            workers.push(thread::spawn(move || {
                loop {
                    let stream = {
                        let receiver = receiver
                            .lock()
                            .expect("production worker receiver mutex poisoned");
                        receiver.recv()
                    };
                    let Ok(mut stream) = stream else {
                        break;
                    };
                    let _ = handle_production_stream_concurrent(&mut stream, &project);
                }
            }));
        }

        Self { sender, workers }
    }

    fn send(&self, stream: TcpStream) -> Result<()> {
        self.sender.send(stream).map_err(|_| {
            DevServerError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "production worker pool is closed",
            ))
        })
    }

    #[cfg(test)]
    fn worker_count(&self) -> usize {
        self.workers.len()
    }

    fn shutdown(self) {
        drop(self.sender);
        for worker in self.workers {
            let _ = worker.join();
        }
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
    server_action_manifests: &'a [ServerActionManifest],
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

fn representative_route_params(route: &Route) -> Vec<(String, Value)> {
    route
        .params
        .iter()
        .filter_map(|param| match param.kind {
            RouteParamKind::Dynamic => {
                Some((param.name.clone(), Value::String(param.name.clone())))
            }
            RouteParamKind::CatchAll => Some((
                param.name.clone(),
                Value::Array(vec![Value::String(param.name.clone())]),
            )),
            RouteParamKind::OptionalCatchAll => None,
        })
        .collect()
}

fn production_client_bundle(
    bundler: &ClientBundler,
    request: ClientBundleRequest<'_>,
) -> std::result::Result<ClientBundle, ClientBundleError> {
    let mut client_bundle = bundler.bundle_route_request(request)?;
    fingerprint_client_bundle(&mut client_bundle, request.out_dir, request.public_path)?;
    Ok(client_bundle)
}

fn route_needs_action_bootstrap(
    renderer: &PageRenderer,
    match_result: &RouteMatch,
    conventions: &RouteConventions,
) -> std::result::Result<bool, PageRenderError> {
    let manifest = match renderer.collect_server_actions(
        &match_result.route.file,
        &match_result.route.layouts,
        &match_result.params,
        conventions,
    ) {
        Ok(manifest) => manifest,
        // Request-time action bootstrap probing is optional; older or narrowly scoped
        // renderer scripts may not implement the manifest mode for non-action routes.
        Err(PageRenderError::Json(_))
        | Err(PageRenderError::Protocol(_))
        | Err(PageRenderError::NodeFailed { .. }) => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(!manifest.actions.is_empty())
}

fn dev_document_scripts(client_bundle: &ClientBundle) -> Vec<String> {
    let mut scripts = BTreeSet::new();
    scripts.insert("/__ferrite/client.js".to_owned());
    scripts.extend(client_bundle.script.iter().cloned());
    scripts.extend(client_bundle.action_bootstrap.iter().cloned());
    for reference in &client_bundle.client_references {
        scripts.extend(reference.script.iter().cloned());
    }
    scripts.into_iter().collect()
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
    project.ensure_ready()?;
    serve_production_listener_concurrent(listener, project)
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

pub fn serve_production_listener_concurrent(
    listener: TcpListener,
    project: ProductionProject,
) -> Result<()> {
    serve_production_listener_with_shutdown(listener, project, ProductionShutdownSignal::never())
}

pub fn serve_production_listener_with_shutdown(
    listener: TcpListener,
    project: ProductionProject,
    shutdown: ProductionShutdownSignal,
) -> Result<()> {
    listener.set_nonblocking(true)?;
    let worker_count = project.config.max_in_flight_requests;
    let project = Arc::new(Mutex::new(project));
    let pool = ProductionWorkerPool::new(worker_count, project);

    while !shutdown.is_shutdown() {
        match listener.accept() {
            Ok((stream, _addr)) => pool.send(stream)?,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                thread::sleep(PRODUCTION_ACCEPT_POLL_INTERVAL);
            }
            Err(error) => {
                pool.shutdown();
                return Err(error.into());
            }
        }
    }

    pool.shutdown();
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
    let request = match read_http_request(stream, DEFAULT_DEV_MAX_REQUEST_BYTES)? {
        RequestReadResult::Request(request) => request,
        RequestReadResult::Response(response) => {
            write_response(stream, &response)?;
            return Ok(());
        }
    };
    let response = match request.method.as_str() {
        "GET" => project.handle_get(&request.path)?,
        "POST" => project.handle_post(&request.path, &request.headers, &request.body)?,
        _ => DevResponse::method_not_allowed(),
    };

    write_response(stream, &response)?;
    Ok(())
}

fn handle_production_stream(stream: &mut TcpStream, project: &mut ProductionProject) -> Result<()> {
    let request_read_timeout = project.config.request_read_timeout;
    let max_request_bytes = project.config.max_request_bytes;
    handle_production_stream_with_limits(
        stream,
        request_read_timeout,
        max_request_bytes,
        |request| match request.method.as_str() {
            "GET" => project.handle_get(&request.path),
            "POST" => project.handle_post(&request.path, &request.headers, &request.body),
            _ => Ok(DevResponse::method_not_allowed()),
        },
    )
}

fn handle_production_stream_concurrent(
    stream: &mut TcpStream,
    project: &Arc<Mutex<ProductionProject>>,
) -> Result<()> {
    let (request_read_timeout, max_request_bytes) = {
        let project = project.lock().expect("production project mutex poisoned");
        (
            project.config.request_read_timeout,
            project.config.max_request_bytes,
        )
    };
    handle_production_stream_with_limits(
        stream,
        request_read_timeout,
        max_request_bytes,
        |request| {
            let mut project = project.lock().expect("production project mutex poisoned");
            match request.method.as_str() {
                "GET" => project.handle_get(&request.path),
                "POST" => project.handle_post(&request.path, &request.headers, &request.body),
                _ => Ok(DevResponse::method_not_allowed()),
            }
        },
    )
}

fn handle_production_stream_with_limits<F>(
    stream: &mut TcpStream,
    request_read_timeout: Duration,
    max_request_bytes: usize,
    mut handle_request: F,
) -> Result<()>
where
    F: FnMut(&ParsedHttpRequest) -> Result<DevResponse>,
{
    stream.set_read_timeout(Some(
        request_read_timeout.max(MIN_PRODUCTION_REQUEST_READ_TIMEOUT),
    ))?;
    let request = match read_http_request(stream, max_request_bytes)? {
        RequestReadResult::Request(request) => request,
        RequestReadResult::Response(response) => {
            write_response(stream, &response)?;
            return Ok(());
        }
    };
    let write_options = ResponseWriteOptions {
        gzip: request.accepts_gzip(),
    };
    let response = handle_request(&request)?;

    write_response_with_options(stream, &response, write_options)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl ParsedHttpRequest {
    fn accepts_gzip(&self) -> bool {
        self.headers
            .get("accept-encoding")
            .is_some_and(|value| accept_encoding_value_allows_gzip(value))
    }
}

enum RequestReadResult {
    Request(ParsedHttpRequest),
    Response(DevResponse),
}

fn read_http_request(
    stream: &mut TcpStream,
    max_request_bytes: usize,
) -> Result<RequestReadResult> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => {
                let Some(header_end) = find_http_header_end(&request) else {
                    return Ok(RequestReadResult::Response(DevResponse::bad_request(
                        "incomplete HTTP request headers",
                    )));
                };
                return finish_read_http_request(stream, request, header_end, max_request_bytes);
            }
            Ok(bytes) => {
                request.extend_from_slice(&buffer[..bytes]);
                if request.len() > max_request_bytes {
                    return Ok(RequestReadResult::Response(DevResponse::payload_too_large()));
                }
                if let Some(header_end) = find_http_header_end(&request) {
                    return finish_read_http_request(
                        stream,
                        request,
                        header_end,
                        max_request_bytes,
                    );
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Ok(RequestReadResult::Response(DevResponse::request_timeout()));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn finish_read_http_request(
    stream: &mut TcpStream,
    mut request: Vec<u8>,
    header_end: usize,
    max_request_bytes: usize,
) -> Result<RequestReadResult> {
    let header_bytes = header_end + 4;
    let mut parsed = match parse_http_request_head(&request[..header_end]) {
        Ok(parsed) => parsed,
        Err(response) => return Ok(RequestReadResult::Response(*response)),
    };

    if !should_read_request_body(&parsed) {
        return Ok(RequestReadResult::Request(parsed));
    }

    let content_length = match action_content_length(&parsed, header_bytes, max_request_bytes) {
        Ok(content_length) => content_length,
        Err(response) => return Ok(RequestReadResult::Response(*response)),
    };
    let expected_len = header_bytes + content_length;
    let mut buffer = [0_u8; 1024];
    while request.len() < expected_len {
        match stream.read(&mut buffer) {
            Ok(0) => {
                return Ok(RequestReadResult::Response(DevResponse::bad_request(
                    "incomplete server action request body",
                )));
            }
            Ok(bytes) => {
                request.extend_from_slice(&buffer[..bytes]);
                if request.len() > max_request_bytes {
                    return Ok(RequestReadResult::Response(DevResponse::payload_too_large()));
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Ok(RequestReadResult::Response(DevResponse::request_timeout()));
            }
            Err(error) => return Err(error.into()),
        }
    }
    parsed.body = request[header_bytes..expected_len].to_vec();

    Ok(RequestReadResult::Request(parsed))
}

fn parse_http_request_head(
    head: &[u8],
) -> std::result::Result<ParsedHttpRequest, Box<DevResponse>> {
    let request = std::str::from_utf8(head).map_err(|_| {
        Box::new(DevResponse::bad_request(
            "HTTP request headers must be UTF-8",
        ))
    })?;
    let Some((method, path)) = parse_request_line(request) else {
        return Err(Box::new(DevResponse::bad_request(
            "invalid HTTP request line",
        )));
    };
    let mut headers = BTreeMap::new();
    for line in request.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(Box::new(DevResponse::bad_request(
                "invalid HTTP request header",
            )));
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(Box::new(DevResponse::bad_request(
                "invalid HTTP request header",
            )));
        }
        headers.insert(name, value.trim().to_owned());
    }

    Ok(ParsedHttpRequest {
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
        body: Vec::new(),
    })
}

fn find_http_header_end(request: &[u8]) -> Option<usize> {
    request.windows(4).position(|window| window == b"\r\n\r\n")
}

fn should_read_request_body(request: &ParsedHttpRequest) -> bool {
    request.method == "POST" && strip_query(&request.path) == SERVER_ACTION_PATH
}

fn action_content_length(
    request: &ParsedHttpRequest,
    header_bytes: usize,
    max_request_bytes: usize,
) -> std::result::Result<usize, Box<DevResponse>> {
    if request
        .headers
        .get("transfer-encoding")
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(Box::new(DevResponse::bad_request(
            "Transfer-Encoding is not supported for server action POST",
        )));
    }

    let Some(value) = request.headers.get("content-length") else {
        return Err(Box::new(DevResponse::bad_request(
            "Content-Length is required for server action POST",
        )));
    };
    let content_length = value.parse::<usize>().map_err(|_| {
        Box::new(DevResponse::bad_request(
            "Content-Length must be a non-negative integer",
        ))
    })?;
    let total = header_bytes
        .checked_add(content_length)
        .unwrap_or(max_request_bytes.saturating_add(1));
    if total > max_request_bytes {
        return Err(Box::new(DevResponse::payload_too_large()));
    }

    Ok(content_length)
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

#[cfg(test)]
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

    for link in &response.link_headers {
        write!(stream, "Link: {}\r\n", sanitize_header_value(link))?;
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

type FormParseResult<T> = std::result::Result<T, String>;

fn parse_urlencoded_form(body: &[u8]) -> FormParseResult<BTreeMap<String, ServerActionFormValue>> {
    let mut fields = BTreeMap::new();
    for pair in body.split(|byte| *byte == b'&') {
        if pair.is_empty() {
            continue;
        }
        let (name, value) = pair
            .iter()
            .position(|byte| *byte == b'=')
            .map_or((pair, &[][..]), |index| {
                (&pair[..index], &pair[index + 1..])
            });
        let name = decode_urlencoded_component(name)?;
        if name.is_empty() {
            return Err("server action form field name must be non-empty".to_owned());
        }
        let value = decode_urlencoded_component(value)?;
        insert_form_value(&mut fields, name, value);
    }
    Ok(fields)
}

fn parse_multipart_form(
    content_type: &str,
    body: &[u8],
) -> FormParseResult<BTreeMap<String, ServerActionFormValue>> {
    let boundary = multipart_boundary(content_type)?;
    let body = std::str::from_utf8(body)
        .map_err(|_| "multipart server action forms must be UTF-8 text".to_owned())?;
    let delimiter = format!("--{boundary}");
    let mut fields = BTreeMap::new();
    let mut saw_boundary = false;

    for raw_part in body.split(&delimiter).skip(1) {
        saw_boundary = true;
        if raw_part.starts_with("--") {
            break;
        }
        let part = raw_part.strip_prefix("\r\n").unwrap_or(raw_part);
        let part = part.strip_suffix("\r\n").unwrap_or(part);
        if part.is_empty() {
            continue;
        }
        let Some((headers, value)) = part.split_once("\r\n\r\n") else {
            return Err("multipart server action part is missing headers".to_owned());
        };
        let headers = parse_multipart_headers(headers)?;
        let disposition = headers.get("content-disposition").ok_or_else(|| {
            "multipart server action part is missing Content-Disposition".to_owned()
        })?;
        if !multipart_disposition_is_form_data(disposition) {
            return Err("multipart server action part must use form-data disposition".to_owned());
        }
        if multipart_disposition_has_file(disposition) {
            return Err("multipart server action file parts are not supported".to_owned());
        }
        let name = multipart_disposition_param(disposition, "name")
            .ok_or_else(|| "multipart server action part is missing a name".to_owned())?;
        if name.is_empty() {
            return Err("server action form field name must be non-empty".to_owned());
        }
        insert_form_value(&mut fields, name, value.to_owned());
    }

    if !saw_boundary {
        return Err("multipart server action body did not contain the boundary".to_owned());
    }

    Ok(fields)
}

fn server_action_request_from_form(
    headers: &HttpHeaders,
    body: &[u8],
) -> std::result::Result<ServerActionRequest, Box<DevResponse>> {
    enforce_server_action_origin(headers)?;
    let mut form = parse_server_action_form(headers, body)
        .map_err(|message| Box::new(DevResponse::bad_request(message)))?;
    let id = remove_required_action_field(&mut form, SERVER_ACTION_ID_FIELD)?;
    let route_path = remove_required_action_field(&mut form, SERVER_ACTION_ROUTE_FIELD)?;
    let request = ServerActionRequest {
        ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
        version: SERVER_ACTION_REQUEST_VERSION,
        id,
        route_path,
        form,
    };
    ferrite_protocol::validate_server_action_request(&request)
        .map_err(|error| Box::new(DevResponse::bad_request(error.to_string())))?;

    Ok(request)
}

fn enforce_server_action_origin(
    headers: &HttpHeaders,
) -> std::result::Result<(), Box<DevResponse>> {
    let Some(host_header) = header_value(headers, "host") else {
        return Ok(());
    };
    let Some(host) = normalize_authority(host_header) else {
        return Err(Box::new(DevResponse::forbidden(
            "server action Host must be a valid HTTP authority",
        )));
    };

    if let Some(origin) = non_empty_header(headers, "origin") {
        let Some(origin_host) = http_header_origin_authority(origin) else {
            return Err(Box::new(DevResponse::forbidden(
                "server action Origin must be an absolute HTTP(S) origin",
            )));
        };
        if origin_host != host {
            return Err(Box::new(DevResponse::forbidden(
                "server action Origin does not match the request Host",
            )));
        }
    }

    if let Some(referer) = non_empty_header(headers, "referer") {
        let Some(referer_host) = http_header_url_authority(referer) else {
            return Err(Box::new(DevResponse::forbidden(
                "server action Referer must be an absolute HTTP(S) URL",
            )));
        };
        if referer_host != host {
            return Err(Box::new(DevResponse::forbidden(
                "server action Referer does not match the request Host",
            )));
        }
    }

    Ok(())
}

fn parse_server_action_form(
    headers: &HttpHeaders,
    body: &[u8],
) -> FormParseResult<BTreeMap<String, ServerActionFormValue>> {
    let content_type = header_value(headers, "content-type")
        .ok_or_else(|| "Content-Type is required for server action POST".to_owned())?;
    let media_type = content_type
        .split_once(';')
        .map_or(content_type, |(media_type, _params)| media_type)
        .trim();
    if media_type.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        return parse_urlencoded_form(body);
    }
    if media_type.eq_ignore_ascii_case("multipart/form-data") {
        return parse_multipart_form(content_type, body);
    }

    Err(format!(
        "unsupported server action form content type `{content_type}`"
    ))
}

fn header_value<'a>(headers: &'a HttpHeaders, name: &str) -> Option<&'a str> {
    headers.get(name).map(String::as_str).or_else(|| {
        headers
            .iter()
            .find(|(candidate, _value)| candidate.eq_ignore_ascii_case(name))
            .map(|(_candidate, value)| value.as_str())
    })
}

fn non_empty_header<'a>(headers: &'a HttpHeaders, name: &str) -> Option<&'a str> {
    header_value(headers, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn http_header_origin_authority(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    if rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return None;
    }
    normalize_authority(rest)
}

fn http_header_url_authority(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|authority| !authority.is_empty())?;
    normalize_authority(authority)
}

fn normalize_authority(value: &str) -> Option<String> {
    let authority = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if authority.is_empty()
        || authority.contains('@')
        || authority.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return None;
    }
    Some(authority)
}

fn remove_required_action_field(
    form: &mut BTreeMap<String, ServerActionFormValue>,
    field: &str,
) -> std::result::Result<String, Box<DevResponse>> {
    match form.remove(field) {
        Some(ServerActionFormValue::String(value)) if !value.is_empty() => Ok(value),
        Some(ServerActionFormValue::String(_)) | None => Err(Box::new(DevResponse::bad_request(
            format!("server action form requires `{field}`"),
        ))),
        Some(ServerActionFormValue::List(_)) => Err(Box::new(DevResponse::bad_request(format!(
            "server action form field `{field}` must contain exactly one value"
        )))),
    }
}

fn server_action_json_response(
    response: ferrite_protocol::ServerActionResponse,
) -> Result<DevResponse> {
    Ok(DevResponse::ok(
        SERVER_ACTION_RESPONSE_CONTENT_TYPE,
        serde_json::to_vec(&response)?,
    ))
}

fn is_unknown_server_action_error(error: &PageRenderError) -> bool {
    matches!(
        error,
        PageRenderError::NodeFailed { stderr, .. }
            if stderr.contains("was not registered during route render")
    )
}

fn decode_urlencoded_component(bytes: &[u8]) -> FormParseResult<String> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err("malformed percent escape in urlencoded form".to_owned());
                }
                let high = hex_value(bytes[index + 1])
                    .ok_or_else(|| "malformed percent escape in urlencoded form".to_owned())?;
                let low = hex_value(bytes[index + 2])
                    .ok_or_else(|| "malformed percent escape in urlencoded form".to_owned())?;
                output.push((high << 4) | low);
                index += 3;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8(output)
        .map_err(|_| "urlencoded server action forms must be UTF-8 text".to_owned())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn insert_form_value(
    fields: &mut BTreeMap<String, ServerActionFormValue>,
    name: String,
    value: String,
) {
    use std::collections::btree_map::Entry;

    match fields.entry(name) {
        Entry::Vacant(entry) => {
            entry.insert(ServerActionFormValue::String(value));
        }
        Entry::Occupied(mut entry) => {
            let slot = entry.get_mut();
            match slot {
                ServerActionFormValue::String(first) => {
                    let first = std::mem::take(first);
                    *slot = ServerActionFormValue::List(vec![first, value]);
                }
                ServerActionFormValue::List(values) => values.push(value),
            }
        }
    }
}

fn multipart_boundary(content_type: &str) -> FormParseResult<String> {
    for parameter in content_type.split(';').skip(1) {
        let Some((name, value)) = parameter.trim().split_once('=') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let value = strip_optional_quotes(value.trim());
        if value.is_empty() || value.contains(['\r', '\n']) {
            return Err("multipart boundary must be non-empty".to_owned());
        }
        return Ok(value.to_owned());
    }

    Err("multipart server action form is missing a boundary".to_owned())
}

fn parse_multipart_headers(headers: &str) -> FormParseResult<BTreeMap<String, String>> {
    let mut parsed = BTreeMap::new();
    for line in headers.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err("multipart server action part contains an invalid header".to_owned());
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err("multipart server action part contains an invalid header".to_owned());
        }
        parsed.insert(name, value.trim().to_owned());
    }
    Ok(parsed)
}

fn multipart_disposition_is_form_data(value: &str) -> bool {
    value
        .split(';')
        .next()
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("form-data"))
}

fn multipart_disposition_has_file(value: &str) -> bool {
    value.split(';').skip(1).any(|parameter| {
        parameter
            .trim()
            .split_once('=')
            .is_some_and(|(name, _value)| {
                let name = name.trim();
                name.eq_ignore_ascii_case("filename") || name.eq_ignore_ascii_case("filename*")
            })
    })
}

fn multipart_disposition_param(value: &str, expected_name: &str) -> Option<String> {
    value.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.trim().split_once('=')?;
        if !name.trim().eq_ignore_ascii_case(expected_name) {
            return None;
        }
        Some(strip_optional_quotes(value.trim()).to_owned())
    })
}

fn strip_optional_quotes(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
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
{metadata_tags}{preloads}{scripts}
{styles}
</head>
<body>
  <div id="ferrite-root" data-route="{path}"{route_pattern}>{page_html}</div>
</body>
</html>"#,
        metadata_tags = metadata_tags,
        preloads = preloads,
        path = escape_html(path),
        route_pattern = route_pattern,
        page_html = page_html,
        styles = styles,
        scripts = render_script_tags(&scripts),
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

fn production_render_error_response(
    path: &str,
    match_result: &RouteMatch,
    error: &PageRenderError,
) -> DevResponse {
    match error {
        PageRenderError::TimedOut { .. } => DevResponse::gateway_timeout(
            render_production_render_error(504, path, match_result, error),
        ),
        _ => DevResponse::internal_error(render_production_render_error(
            500,
            path,
            match_result,
            error,
        )),
    }
}

fn render_production_render_error(
    status: u16,
    path: &str,
    match_result: &RouteMatch,
    error: &PageRenderError,
) -> String {
    let title = if status == 504 {
        "Ferrite - Render Timeout"
    } else {
        "Ferrite - Render Error"
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{title}</title></head>
<body>
  <main id="ferrite-root" data-route="{path}" data-route-pattern="{pattern}">
    <h1>{status}</h1>
    <p>Ferrite could not render <code>{pattern}</code>.</p>
    <pre>{error}</pre>
  </main>
</body>
</html>"#,
        title = title,
        status = status,
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
    use ferrite_protocol::ServerActionFormValue;
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
const serverActionManifestMode = mode === "--server-action-manifest";
const explicitMode = metadataMode || streamMode || serverPayloadMode || documentMode || documentStreamMode || documentServerPayloadMode || serverActionManifestMode;
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
if (serverActionManifestMode) {
  process.stdout.write(JSON.stringify({
    routePath: page.includes("[id]") ? `/posts/${props.params.id}` : "/",
    routePattern: page.includes("[id]") ? "/posts/[id]" : "/",
    actions: page.includes("[id]") ? [{
      ferrite: "server-action-reference",
      version: 1,
      id: "app/posts/[id]/page.tsx#savePost",
      routePattern: "/posts/[id]",
      url: "/_ferrite/action",
      bound: {}
    }] : []
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

    fn action_project_for(app: &Path, renderer_body: &str) -> DevProject {
        let project = app.parent().unwrap().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(&renderer, renderer_body);
        let bundler = project.join("build-client.mjs");
        make_script(
            &bundler,
            r#"
process.stdout.write(JSON.stringify({
  script: "/_ferrite/static/route.js",
  styles: [],
  outputs: [],
  sourcemaps: [],
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

    fn action_production_project_for(app: &Path, renderer_body: &str) -> ProductionProject {
        let dev_project = action_project_for(app, renderer_body);
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

    fn action_renderer_body() -> &'static str {
        r##"
const mode = process.argv[2];
if (mode === "--server-action") {
  const props = JSON.parse(process.argv[4]);
  const layouts = JSON.parse(process.argv[5]);
  const conventions = JSON.parse(process.argv[6]);
  const request = JSON.parse(process.argv[7]);
  if (request.id.endsWith("#missing")) {
    console.error(`Ferrite server action "${request.id}" was not registered during route render.`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ferrite: "server-action-response",
    version: 1,
    status: "ok",
    data: {
      id: request.id,
      routePath: request.routePath,
      title: request.form.title ?? null,
      tag: request.form.tag ?? null,
      params: props.params,
      layoutCount: layouts.length,
      hasLoading: Boolean(conventions.loading)
    }
  }));
  process.exit(0);
}
console.error(`unexpected renderer mode ${mode}`);
process.exit(1);
"##
    }

    fn action_headers(content_type: &str) -> HttpHeaders {
        BTreeMap::from([("content-type".to_owned(), content_type.to_owned())])
    }

    fn action_headers_with_host(content_type: &str) -> HttpHeaders {
        BTreeMap::from([
            ("content-type".to_owned(), content_type.to_owned()),
            ("host".to_owned(), "localhost:3000".to_owned()),
        ])
    }

    fn action_form_body(route: &str) -> Vec<u8> {
        format!(
            "__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route={}&title=Hello+Ferrite&tag=rust&tag=tsx",
            route.replace('/', "%2F")
        )
        .into_bytes()
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

    fn static_script_src(html: &str) -> String {
        html.split("src=\"")
            .find_map(|part| part.strip_prefix("/_ferrite/static/"))
            .and_then(|part| part.split('"').next())
            .map(|path| format!("/_ferrite/static/{path}"))
            .expect("client script")
    }

    fn assert_modulepreload_link_header(headers: &str, script: &str) {
        assert!(
            headers.contains(&format!("Link: <{script}>; rel=modulepreload; as=script")),
            "headers did not contain modulepreload Link for {script}:\n{headers}"
        );
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

    fn request_to_addr(addr: std::net::SocketAddr, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.write_all(request).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn read_request_from_client(request: &[u8], max_request_bytes: usize) -> RequestReadResult {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let request = request.to_vec();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.write_all(&request).unwrap();
        });
        let (mut stream, _addr) = listener.accept().unwrap();
        let result = read_http_request(&mut stream, max_request_bytes).unwrap();
        client.join().unwrap();
        result
    }

    fn wait_for_path(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn urlencoded_action_form_collects_duplicate_values() {
        let form = parse_urlencoded_form(b"title=Hello+Rust&tag=rust&tag=tsx&empty=").unwrap();

        assert_eq!(
            form.get("title"),
            Some(&ServerActionFormValue::String("Hello Rust".to_owned()))
        );
        assert_eq!(
            form.get("tag"),
            Some(&ServerActionFormValue::List(vec![
                "rust".to_owned(),
                "tsx".to_owned()
            ]))
        );
        assert_eq!(
            form.get("empty"),
            Some(&ServerActionFormValue::String(String::new()))
        );
    }

    #[test]
    fn urlencoded_action_form_rejects_malformed_percent_escape() {
        let error = parse_urlencoded_form(b"title=%GG").unwrap_err();

        assert!(error.contains("percent escape"), "{error}");
    }

    #[test]
    fn multipart_action_form_accepts_text_fields_and_rejects_file_parts() {
        let content_type = "multipart/form-data; boundary=FerriteBoundary";
        let body = b"--FerriteBoundary\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nHello multipart\r\n--FerriteBoundary\r\nContent-Disposition: form-data; name=\"tag\"\r\n\r\nrust\r\n--FerriteBoundary\r\nContent-Disposition: form-data; name=\"tag\"\r\n\r\ntsx\r\n--FerriteBoundary--\r\n";
        let form = parse_multipart_form(content_type, body).unwrap();

        assert_eq!(
            form.get("title"),
            Some(&ServerActionFormValue::String("Hello multipart".to_owned()))
        );
        assert_eq!(
            form.get("tag"),
            Some(&ServerActionFormValue::List(vec![
                "rust".to_owned(),
                "tsx".to_owned()
            ]))
        );

        let file_body = b"--FerriteBoundary\r\nContent-Disposition: form-data; name=\"asset\"; filename=\"avatar.png\"\r\nContent-Type: image/png\r\n\r\nnot-text\r\n--FerriteBoundary--\r\n";
        let error = parse_multipart_form(content_type, file_body).unwrap_err();
        assert!(error.contains("file parts"), "{error}");
    }

    #[test]
    fn action_post_reader_preserves_body() {
        let result = read_request_from_client(
            b"POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 16\r\n\r\ntitle=Hello+Rust",
            1024,
        );

        let RequestReadResult::Request(request) = result else {
            panic!("expected parsed request");
        };
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/_ferrite/action");
        assert_eq!(
            request.headers.get("content-type"),
            Some(&"application/x-www-form-urlencoded".to_owned())
        );
        assert_eq!(request.body, b"title=Hello+Rust");
    }

    #[test]
    fn action_post_reader_rejects_missing_content_length() {
        let result = read_request_from_client(
            b"POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\n\r\ntitle=Hello",
            1024,
        );

        let RequestReadResult::Response(response) = result else {
            panic!("expected HTTP error response");
        };
        assert_eq!(response.status, 400);
        assert!(response.body_text().contains("Content-Length"));
    }

    #[test]
    fn action_post_reader_rejects_oversized_body() {
        let result = read_request_from_client(
            b"POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nContent-Length: 128\r\n\r\nshort",
            64,
        );

        let RequestReadResult::Response(response) = result else {
            panic!("expected HTTP error response");
        };
        assert_eq!(response.status, 413);
    }

    #[test]
    fn action_post_reader_rejects_transfer_encoding() {
        let result = read_request_from_client(
            b"POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            1024,
        );

        let RequestReadResult::Response(response) = result else {
            panic!("expected HTTP error response");
        };
        assert_eq!(response.status, 400);
        assert!(response.body_text().contains("Transfer-Encoding"));
    }

    #[test]
    fn action_form_origin_guard_accepts_same_host_and_rejects_cross_origin() {
        let mut same_origin = action_headers_with_host("application/x-www-form-urlencoded");
        same_origin.insert("origin".to_owned(), "http://localhost:3000".to_owned());

        let request =
            server_action_request_from_form(&same_origin, &action_form_body("/posts/abc"))
                .expect("same-origin action request should parse");
        assert_eq!(request.route_path, "/posts/abc");

        let mut cross_origin = same_origin.clone();
        cross_origin.insert("origin".to_owned(), "https://evil.example".to_owned());
        let response =
            server_action_request_from_form(&cross_origin, &action_form_body("/posts/abc"))
                .expect_err("cross-origin action request should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Origin"));

        let mut malformed_host = action_headers_with_host("application/x-www-form-urlencoded");
        malformed_host.insert("host".to_owned(), "local host".to_owned());
        malformed_host.insert("origin".to_owned(), "http://localhost".to_owned());
        let response =
            server_action_request_from_form(&malformed_host, &action_form_body("/posts/abc"))
                .expect_err("malformed host should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Host"));
    }

    #[test]
    fn dev_action_post_invokes_route_action_with_urlencoded_form() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/layout.tsx"),
            "export default function Layout() {}",
        );
        write(
            &app.join("posts/[id]/loading.tsx"),
            "export default function Loading() {}",
        );
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_project_for(&app, action_renderer_body());

        let response = project
            .handle_post(
                "/_ferrite/action",
                &action_headers("application/x-www-form-urlencoded"),
                &action_form_body("/posts/abc"),
            )
            .unwrap();
        let body: Value = serde_json::from_slice(&response.body).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json; charset=utf-8");
        assert_eq!(body["status"], "ok");
        assert_eq!(
            body["data"],
            json!({
                "id": "app/posts/[id]/page.tsx#savePost",
                "routePath": "/posts/abc",
                "title": "Hello Ferrite",
                "tag": ["rust", "tsx"],
                "params": { "id": "abc" },
                "layoutCount": 1,
                "hasLoading": true
            })
        );
    }

    #[test]
    fn dev_action_post_rejects_cross_origin_origin() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_project_for(&app, action_renderer_body());
        let mut headers = action_headers_with_host("application/x-www-form-urlencoded");
        headers.insert("origin".to_owned(), "https://evil.example".to_owned());

        let response = project
            .handle_post(
                "/_ferrite/action",
                &headers,
                &action_form_body("/posts/abc"),
            )
            .unwrap();

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Origin"));
    }

    #[test]
    fn dev_action_post_rejects_missing_metadata_fields() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_project_for(&app, action_renderer_body());

        let response = project
            .handle_post(
                "/_ferrite/action",
                &action_headers("application/x-www-form-urlencoded"),
                b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&title=Hello",
            )
            .unwrap();

        assert_eq!(response.status, 400);
        assert!(response.body_text().contains("__ferrite_route"));
    }

    #[test]
    fn dev_action_post_reports_unknown_routes_and_unsupported_media_types() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_project_for(&app, action_renderer_body());

        let unknown = project
            .handle_post(
                "/_ferrite/action",
                &action_headers("application/x-www-form-urlencoded"),
                &action_form_body("/missing"),
            )
            .unwrap();
        assert_eq!(unknown.status, 404);
        assert!(unknown.body_text().contains("/missing"));

        let unsupported = project
            .handle_post(
                "/_ferrite/action",
                &action_headers("text/plain"),
                &action_form_body("/posts/abc"),
            )
            .unwrap();
        assert_eq!(unsupported.status, 400);
        assert!(unsupported.body_text().contains("unsupported"));
    }

    #[test]
    fn production_action_post_observes_real_socket_requests() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let mut project = action_production_project_for(&app, action_renderer_body());
        project.config.request_observer = Some(ProductionRequestObserver::new(move |event| {
            captured_events.lock().unwrap().push(event);
        }));
        let body = action_form_body("/posts/abc");
        let request = format!(
            "POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body).unwrap()
        );

        let response = production_http_request(project, request.as_bytes());
        let headers = response_headers(&response);
        let body: Value = serde_json::from_slice(response_body(&response)).unwrap();
        let events = events.lock().unwrap();

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(body["status"], "ok");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].method, "POST");
        assert_eq!(events[0].path, "/_ferrite/action");
        assert_eq!(events[0].status, 200);
        assert_eq!(events[0].route_pattern.as_deref(), Some("/posts/:id"));
    }

    #[test]
    fn production_action_post_rejects_cross_origin_referer_on_real_socket() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let project = action_production_project_for(&app, action_renderer_body());
        let body = action_form_body("/posts/abc");
        let request = format!(
            "POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nReferer: https://evil.example/form\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body).unwrap()
        );

        let response = production_http_request(project, request.as_bytes());
        let headers = response_headers(&response);
        let body = String::from_utf8_lossy(response_body(&response));

        assert!(headers.starts_with("HTTP/1.1 403 Forbidden"));
        assert!(body.contains("Referer"));
    }

    #[test]
    fn production_config_defaults_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);

        assert_eq!(
            project.config.request_read_timeout,
            DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT
        );
        assert_eq!(
            project.config.render_timeout,
            DEFAULT_PRODUCTION_RENDER_TIMEOUT
        );
        assert_eq!(
            project.config.max_request_bytes,
            DEFAULT_PRODUCTION_MAX_REQUEST_BYTES
        );
        assert_eq!(
            project.config.max_in_flight_requests,
            DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS
        );
    }

    #[test]
    fn production_config_builders_clamp_empty_limits() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = ProductionProject::new(
            production_project_for(&app)
                .config
                .with_request_read_timeout(Duration::ZERO)
                .with_render_timeout(Duration::ZERO)
                .with_max_request_bytes(0)
                .with_max_in_flight_requests(0),
        );

        assert_eq!(
            project.config.request_read_timeout,
            MIN_PRODUCTION_REQUEST_READ_TIMEOUT
        );
        assert_eq!(project.config.render_timeout, MIN_PRODUCTION_RENDER_TIMEOUT);
        assert_eq!(project.config.max_request_bytes, 1);
        assert_eq!(project.config.max_in_flight_requests, 1);
    }

    #[test]
    fn production_observer_records_route_responses() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed_events = Arc::clone(&events);
        let mut project =
            ProductionProject::new(production_project_for(&app).config.with_request_observer(
                move |event| {
                    observed_events.lock().unwrap().push(event);
                },
            ));

        let response = project.handle_get("/posts/abc").unwrap();

        assert_eq!(response.status, 200);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].method, "GET");
        assert_eq!(events[0].path, "/posts/abc");
        assert_eq!(events[0].status, 200);
        assert_eq!(events[0].route_pattern.as_deref(), Some("/posts/:id"));
        assert!(events[0].elapsed > Duration::ZERO);
    }

    #[test]
    fn production_render_timeout_returns_gateway_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
setInterval(() => {}, 1000);
"#,
        );
        let mut project = ProductionProject::new(
            ProductionServerConfig::new(
                project.clone(),
                app,
                project.join(".ferrite/types/routes.d.ts"),
                renderer,
                project.join("build-client.mjs"),
                project.join(".ferrite/server/static"),
                "/_ferrite/static".to_owned(),
            )
            .with_render_timeout(Duration::from_millis(20)),
        );

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 504);
        assert_eq!(response.reason, "Gateway Timeout");
        assert_eq!(response.cache_control, Some("no-store"));
        assert_eq!(response.route_pattern_header.as_deref(), Some("/"));
        let body = response.body_text();
        assert!(body.contains("<h1>504</h1>"));
        assert!(body.contains("page renderer timed out"));
        assert!(body.contains(r#"id="ferrite-root""#));
    }

    #[test]
    fn production_worker_pool_clamps_empty_worker_count() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(Mutex::new(production_project_for(&app)));

        let pool = ProductionWorkerPool::new(0, project);

        assert_eq!(pool.worker_count(), 1);
        pool.shutdown();
    }

    #[test]
    fn production_worker_pool_serves_multiple_requests() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let project = production_project_for(&app);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();

        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let home = request_to_addr(addr, b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
        let post = request_to_addr(addr, b"GET /posts/abc HTTP/1.1\r\nHost: localhost\r\n\r\n");
        controller.shutdown();
        server.join().unwrap();

        assert!(home.starts_with("HTTP/1.1 200 OK"));
        assert!(home.contains("X-Ferrite-Route-Pattern: /"));
        assert!(post.starts_with("HTTP/1.1 200 OK"));
        assert!(post.contains("X-Ferrite-Route-Pattern: /posts/:id"));
    }

    #[test]
    fn production_shutdown_drains_accepted_requests() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let marker = temp.path().join("render-started.txt");
        let marker_json = serde_json::to_string(marker.to_str().unwrap()).unwrap();
        let project = production_project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            &format!(
                r#"
const fs = await import("node:fs/promises");
const mode = process.argv[2];
if (mode === "--metadata") {{
  process.stdout.write(JSON.stringify({{ title: "Drained", description: "Shutdown drain" }}));
  process.exit(0);
}}
if (mode === "--stream") {{
  await fs.writeFile({marker_json}, "started");
  await new Promise((resolve) => setTimeout(resolve, 80));
  process.stdout.write(JSON.stringify({{
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", {{}}, [[2, "h1", {{}}, [[0, "Drained request"]]]]],
    chunks: []
  }}));
  process.exit(0);
}}
process.stdout.write(JSON.stringify({{ kind: "text", value: "unexpected" }}));
"#
            ),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();

        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        wait_for_path(&marker);
        controller.shutdown();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Drained request"));
    }

    #[test]
    fn production_adapter_rejects_oversized_request_headers() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = production_project_for(&app);
        project.config.max_request_bytes = 32;

        let response = production_http_request(
            project,
            b"GET / HTTP/1.1\r\nHost: localhost\r\nX-Long: 1234567890\r\n\r\n",
        );
        let headers = response_headers(&response);
        let body = String::from_utf8_lossy(response_body(&response));

        assert!(headers.starts_with("HTTP/1.1 413 Payload Too Large"));
        assert!(headers.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(headers.contains("Content-Length:"));
        assert_eq!(body, "Payload Too Large\n");
    }

    #[test]
    fn production_adapter_times_out_silent_request_reads() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = production_project_for(&app);
        project.config.request_read_timeout = Duration::from_millis(50);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            serve_production_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 408 Request Timeout"));
        assert!(response.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(response.ends_with("Request Timeout\n"));
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

        let build = project.handle_get("/__ferrite/build").unwrap();
        assert_eq!(build.status, 200);
        let manifest: serde_json::Value = serde_json::from_str(&build.body_text()).unwrap();
        assert_eq!(
            manifest["server_action_manifests"][0]["routePath"].as_str(),
            Some("/posts/id")
        );
        assert_eq!(
            manifest["server_action_manifests"][0]["actions"][0]["id"].as_str(),
            Some("app/posts/[id]/page.tsx#savePost")
        );
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
            action_bootstrap: None,
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
            action_bootstrap: None,
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
            action_bootstrap: None,
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

        let action_route = ClientBundle {
            script: None,
            action_bootstrap: Some("/_ferrite/static/route-index-action-bootstrap.js".to_owned()),
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
        };
        assert_eq!(
            dev_document_scripts(&action_route),
            vec![
                "/__ferrite/client.js",
                "/_ferrite/static/route-index-action-bootstrap.js"
            ]
        );
        assert_eq!(
            client_bundle_scripts(&action_route),
            vec!["/_ferrite/static/route-index-action-bootstrap.js"]
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
        let script = static_script_src(&body);
        assert_fingerprinted_public_path(&script, ".js");
        assert!(body.contains(&format!(r#"<link rel="modulepreload" href="{script}">"#)));
        assert_eq!(
            response.link_headers,
            vec![format!("<{script}>; rel=modulepreload; as=script")]
        );
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
        assert!(response.link_headers.is_empty());
        assert!(response.body_text().contains("console.log('client')"));

        let unhashed = project.config().client_out_dir.join("manual.js");
        write(&unhashed, "console.log('manual');");
        let unhashed_response = project.handle_get("/_ferrite/static/manual.js").unwrap();
        assert_eq!(unhashed_response.status, 200);
        assert_eq!(
            unhashed_response.cache_control,
            Some("public, max-age=0, must-revalidate")
        );
        assert!(unhashed_response.link_headers.is_empty());
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
        let script = static_script_src(&response);
        let headers = response.split("\r\n\r\n").next().expect("headers");
        assert_modulepreload_link_header(headers, &script);
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
        let script = static_script_src(&body);
        assert_modulepreload_link_header(&headers, &script);
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
        let script = static_script_src(&body);
        assert_modulepreload_link_header(&headers, &script);
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
        assert!(!headers.contains("Link:"));
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
    fn injects_action_bootstrap_for_server_only_action_routes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = project_for(&app);
        make_script(
            &temp.path().join("build-client.mjs"),
            r#"
const outDir = process.argv[3];
const options = JSON.parse(process.argv[8] || "{}");
const fs = await import("node:fs/promises");
const path = await import("node:path");
await fs.mkdir(outDir, { recursive: true });
if (options.actionBootstrap === true) {
  await fs.writeFile(path.join(outDir, "route-posts-id-action-bootstrap.js"), "console.log('action-bootstrap');");
  process.stdout.write(JSON.stringify({
    script: null,
    actionBootstrap: "/_ferrite/static/route-posts-id-action-bootstrap.js",
    styles: [],
    outputs: ["route-posts-id-action-bootstrap.js"],
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

        let html = project.handle_get("/posts/alpha").unwrap();
        let html_body = html.body_text();
        assert_eq!(html.status, 200);
        assert!(html_body.contains(
            r#"<script type="module" src="/_ferrite/static/route-posts-id-action-bootstrap.js"></script>"#
        ));
        assert!(
            !html_body.contains(r#"<script type="module" src="/_ferrite/static/route-posts-id.js"#)
        );

        let response = project
            .handle_get("/_ferrite/static/route-posts-id-action-bootstrap.js")
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "text/javascript; charset=utf-8");
        assert!(response.body_text().contains("action-bootstrap"));
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
