use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use ferrite_builder::{
    FERRITE_PRODUCTION_ARTIFACT_MANIFEST, ProductionArtifactError, load_production_artifact,
};
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
const SERVER_ACTION_CSRF_FIELD: &str = "__ferrite_csrf";
const SERVER_ACTION_REPLAY_NONCE_FIELD: &str = "__ferrite_nonce";
const SERVER_ACTION_RESPONSE_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const SERVER_ACTION_CSRF_COOKIE_ATTRIBUTES: &str = "Path=/; SameSite=Lax; HttpOnly; Secure";
const DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_PRODUCTION_REQUEST_READ_TIMEOUT: Duration = Duration::from_millis(1);
const DEFAULT_PRODUCTION_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_PRODUCTION_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_millis(1);
const DEFAULT_PRODUCTION_RENDER_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_PRODUCTION_RENDER_TIMEOUT: Duration = Duration::from_millis(1);
const DEFAULT_PRODUCTION_MAX_REQUEST_BYTES: usize = 16 * 1024;
const DEFAULT_DEV_MAX_REQUEST_BYTES: usize = DEFAULT_PRODUCTION_MAX_REQUEST_BYTES;
const DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS: usize = 64;
const PRODUCTION_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_PRODUCTION_OVERLOAD_WORKERS: usize = 4;
const PRODUCTION_OVERLOAD_REQUEST_DRAIN_TIMEOUT: Duration = Duration::from_millis(25);
const PRODUCTION_OVERLOAD_WRITE_TIMEOUT: Duration = Duration::from_millis(100);
const PRODUCTION_RESPONSE_WRITE_DEADLINE_MESSAGE: &str =
    "production response write deadline exceeded";
const SERVER_ACTION_REPLAY_NONCE_BYTES: usize = 16;

#[derive(Debug)]
pub enum DevServerError {
    Artifact(ProductionArtifactError),
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
            DevServerError::Artifact(error) => write!(f, "{error}"),
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

impl From<ProductionArtifactError> for DevServerError {
    fn from(error: ProductionArtifactError) -> Self {
        DevServerError::Artifact(error)
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
    pub server_action_csrf_token: Option<String>,
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
            server_action_csrf_token: None,
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
    pub client_ip: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionActionEvent {
    pub action_id: Option<String>,
    pub route_path: Option<String>,
    pub route_pattern: Option<String>,
    pub status: u16,
    pub outcome: ProductionActionOutcome,
    pub client_ip: Option<String>,
    pub elapsed: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionActionOutcome {
    Accepted,
    Rejected,
}

#[derive(Clone)]
pub struct ProductionActionObserver {
    observe: Arc<dyn Fn(ProductionActionEvent) + Send + Sync>,
}

impl ProductionActionObserver {
    pub fn new<F>(observe: F) -> Self
    where
        F: Fn(ProductionActionEvent) + Send + Sync + 'static,
    {
        Self {
            observe: Arc::new(observe),
        }
    }

    fn observe(&self, event: ProductionActionEvent) {
        (self.observe)(event);
    }
}

impl fmt::Debug for ProductionActionObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProductionActionObserver")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Default)]
struct ProductionMetrics {
    inner: Arc<Mutex<ProductionMetricsSnapshot>>,
}

#[derive(Debug, Clone, Default)]
struct ProductionMetricsSnapshot {
    requests: BTreeMap<ProductionRequestMetricKey, u64>,
    actions: BTreeMap<ProductionActionMetricKey, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ProductionRequestMetricKey {
    method: String,
    status: u16,
    route: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ProductionActionMetricKey {
    outcome: ProductionActionOutcome,
    status: u16,
    route: String,
}

impl ProductionMetrics {
    fn record_request(&self, method: &str, status: u16, route_pattern: Option<&str>) {
        let key = ProductionRequestMetricKey {
            method: method.to_owned(),
            status,
            route: route_pattern.unwrap_or("-").to_owned(),
        };
        *self
            .inner
            .lock()
            .expect("production metrics mutex poisoned")
            .requests
            .entry(key)
            .or_insert(0) += 1;
    }

    fn record_action(
        &self,
        outcome: ProductionActionOutcome,
        status: u16,
        route_pattern: Option<&str>,
    ) {
        let key = ProductionActionMetricKey {
            outcome,
            status,
            route: route_pattern.unwrap_or("-").to_owned(),
        };
        *self
            .inner
            .lock()
            .expect("production metrics mutex poisoned")
            .actions
            .entry(key)
            .or_insert(0) += 1;
    }

    fn render(&self) -> String {
        let snapshot = self
            .inner
            .lock()
            .expect("production metrics mutex poisoned")
            .clone();
        render_production_metrics(&snapshot)
    }
}

fn render_production_metrics(snapshot: &ProductionMetricsSnapshot) -> String {
    let mut output = String::from(
        "# HELP ferrite_production_requests_total Production HTTP requests handled by Ferrite.\n\
         # TYPE ferrite_production_requests_total counter\n",
    );
    for (key, count) in &snapshot.requests {
        output.push_str(&format!(
            "ferrite_production_requests_total{{method=\"{}\",status=\"{}\",route=\"{}\"}} {}\n",
            prometheus_label_value(&key.method),
            key.status,
            prometheus_label_value(&key.route),
            count
        ));
    }
    output.push_str(
        "# HELP ferrite_production_actions_total Production server-action attempts handled by Ferrite.\n\
         # TYPE ferrite_production_actions_total counter\n",
    );
    for (key, count) in &snapshot.actions {
        output.push_str(&format!(
            "ferrite_production_actions_total{{outcome=\"{}\",status=\"{}\",route=\"{}\"}} {}\n",
            production_action_outcome_label(key.outcome),
            key.status,
            prometheus_label_value(&key.route),
            count
        ));
    }
    output
}

fn production_action_outcome_label(outcome: ProductionActionOutcome) -> &'static str {
    match outcome {
        ProductionActionOutcome::Accepted => "accepted",
        ProductionActionOutcome::Rejected => "rejected",
    }
}

fn prometheus_label_value(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            _ => vec![character],
        })
        .collect()
}

#[derive(Debug)]
struct ProductionReplayNonces {
    ttl: Duration,
    entries: BTreeMap<String, Instant>,
}

impl ProductionReplayNonces {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: BTreeMap::new(),
        }
    }

    fn issue(&mut self) -> std::result::Result<String, Box<DevResponse>> {
        self.prune_expired(Instant::now());
        let nonce = generate_server_action_replay_nonce().map_err(|error| {
            Box::new(
                DevResponse::internal_error(format!(
                    "<h1>500</h1><p>could not generate server-action replay nonce: {error}</p>"
                ))
                .with_cache_control("no-store"),
            )
        })?;
        self.entries
            .insert(nonce.clone(), Instant::now() + self.ttl);
        Ok(nonce)
    }

    fn consume(&mut self, nonce: &str) -> bool {
        self.prune_expired(Instant::now());
        self.entries.remove(nonce).is_some()
    }

    fn prune_expired(&mut self, now: Instant) {
        self.entries.retain(|_, expires_at| *expires_at > now);
    }
}

fn generate_server_action_replay_nonce() -> std::result::Result<String, getrandom::Error> {
    let mut bytes = [0_u8; SERVER_ACTION_REPLAY_NONCE_BYTES];
    getrandom::getrandom(&mut bytes)?;
    Ok(hex_encode(&bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionTrustedProxyConfig {
    public_origin: HttpOrigin,
}

impl ProductionTrustedProxyConfig {
    pub fn new(public_origin: &str) -> std::result::Result<Self, String> {
        let public_origin = http_header_origin(public_origin).ok_or_else(|| {
            "trusted proxy public origin must be an absolute HTTP(S) origin without a path"
                .to_owned()
        })?;
        Ok(Self { public_origin })
    }

    pub fn public_origin(&self) -> String {
        self.public_origin.to_string()
    }
}

#[derive(Debug, Clone)]
pub struct ProductionServerConfig {
    pub project: PathBuf,
    pub artifact_root: Option<PathBuf>,
    pub artifact_build_id: Option<String>,
    pub app_dir: PathBuf,
    pub types_out: PathBuf,
    pub page_renderer: PathBuf,
    pub client_bundler: PathBuf,
    pub client_out_dir: PathBuf,
    pub client_public_path: String,
    pub request_read_timeout: Duration,
    pub response_write_timeout: Duration,
    pub render_timeout: Duration,
    pub max_request_bytes: usize,
    pub max_in_flight_requests: usize,
    pub server_action_csrf_token: Option<String>,
    pub server_action_csrf_cookie_name: Option<String>,
    pub trusted_proxy: Option<ProductionTrustedProxyConfig>,
    pub trusted_proxy_client_ip_hops: Option<usize>,
    pub request_observer: Option<ProductionRequestObserver>,
    pub action_observer: Option<ProductionActionObserver>,
    pub metrics_path: Option<String>,
    pub server_action_replay_ttl: Option<Duration>,
    metrics: ProductionMetrics,
}

impl ProductionServerConfig {
    #[cfg(test)]
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
            artifact_root: None,
            artifact_build_id: None,
            app_dir,
            types_out,
            page_renderer,
            client_bundler,
            client_out_dir,
            client_public_path,
            request_read_timeout: DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT,
            response_write_timeout: DEFAULT_PRODUCTION_RESPONSE_WRITE_TIMEOUT,
            render_timeout: DEFAULT_PRODUCTION_RENDER_TIMEOUT,
            max_request_bytes: DEFAULT_PRODUCTION_MAX_REQUEST_BYTES,
            max_in_flight_requests: DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS,
            server_action_csrf_token: None,
            server_action_csrf_cookie_name: None,
            trusted_proxy: None,
            trusted_proxy_client_ip_hops: None,
            request_observer: None,
            action_observer: None,
            metrics_path: None,
            server_action_replay_ttl: None,
            metrics: ProductionMetrics::default(),
        }
    }

    pub fn from_artifact(project: PathBuf, artifact_root: PathBuf, page_renderer: PathBuf) -> Self {
        Self {
            project,
            artifact_root: Some(artifact_root),
            artifact_build_id: None,
            app_dir: PathBuf::new(),
            types_out: PathBuf::new(),
            page_renderer,
            client_bundler: PathBuf::new(),
            client_out_dir: PathBuf::new(),
            client_public_path: String::new(),
            request_read_timeout: DEFAULT_PRODUCTION_REQUEST_READ_TIMEOUT,
            response_write_timeout: DEFAULT_PRODUCTION_RESPONSE_WRITE_TIMEOUT,
            render_timeout: DEFAULT_PRODUCTION_RENDER_TIMEOUT,
            max_request_bytes: DEFAULT_PRODUCTION_MAX_REQUEST_BYTES,
            max_in_flight_requests: DEFAULT_PRODUCTION_MAX_IN_FLIGHT_REQUESTS,
            server_action_csrf_token: None,
            server_action_csrf_cookie_name: None,
            trusted_proxy: None,
            trusted_proxy_client_ip_hops: None,
            request_observer: None,
            action_observer: None,
            metrics_path: None,
            server_action_replay_ttl: None,
            metrics: ProductionMetrics::default(),
        }
    }

    pub fn with_request_read_timeout(mut self, timeout: Duration) -> Self {
        self.request_read_timeout = timeout.max(MIN_PRODUCTION_REQUEST_READ_TIMEOUT);
        self
    }

    pub fn with_response_write_timeout(mut self, timeout: Duration) -> Self {
        self.response_write_timeout = timeout.max(MIN_PRODUCTION_RESPONSE_WRITE_TIMEOUT);
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

    pub fn with_server_action_csrf_token(mut self, token: impl Into<String>) -> Self {
        self.server_action_csrf_token = Some(token.into());
        self
    }

    pub fn with_server_action_csrf_cookie_name(mut self, name: impl Into<String>) -> Self {
        self.server_action_csrf_cookie_name = Some(name.into());
        self
    }

    pub fn with_trusted_proxy(mut self, trusted_proxy: ProductionTrustedProxyConfig) -> Self {
        self.trusted_proxy = Some(trusted_proxy);
        self
    }

    pub fn with_trusted_proxy_client_ip_hops(mut self, hops: usize) -> Self {
        self.trusted_proxy_client_ip_hops = Some(hops.max(1));
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

    pub fn with_action_observer<F>(mut self, observer: F) -> Self
    where
        F: Fn(ProductionActionEvent) + Send + Sync + 'static,
    {
        self.action_observer = Some(ProductionActionObserver::new(observer));
        self
    }

    pub fn with_metrics_path(mut self, path: impl Into<String>) -> Self {
        self.metrics_path = Some(path.into());
        self
    }

    pub fn with_server_action_replay_ttl(mut self, ttl: Duration) -> Self {
        self.server_action_replay_ttl = Some(ttl.max(Duration::from_millis(1)));
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
            let renderer = self.page_renderer();
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

    fn page_renderer(&self) -> PageRenderer {
        let renderer = PageRenderer::new(
            self.config.project.clone(),
            self.config.page_renderer.clone(),
        );
        match &self.config.server_action_csrf_token {
            Some(token) => renderer.with_server_action_csrf_token(token.clone()),
            None => renderer,
        }
    }

    fn action_response(&self, headers: &HttpHeaders, body: &[u8]) -> Result<DevResponse> {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");
        let request = match server_action_request_from_form(
            headers,
            body,
            self.config.server_action_csrf_token.as_deref(),
            None,
            None,
            None,
        ) {
            Ok(request) => request,
            Err(response) => return Ok(*response),
        };
        let route_path = request.route_path.clone();
        let Some(match_result) = match_route(&route_path, &snapshot.routes) else {
            return Ok(DevResponse::not_found_text(format!(
                "No Ferrite route matched server action route `{route_path}`"
            )));
        };
        let renderer = self.page_renderer();
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
                        options: ClientBundleOptions {
                            action_bootstrap,
                            runtime_props: false,
                        },
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
                                    server_action_csrf_token: self
                                        .config
                                        .server_action_csrf_token
                                        .clone(),
                                    server_action_replay_nonce: None,
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
                            options: ClientBundleOptions {
                                action_bootstrap,
                                runtime_props: false,
                            },
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
                        options: ClientBundleOptions {
                            action_bootstrap,
                            runtime_props: false,
                        },
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
                                    server_action_csrf_token: self
                                        .config
                                        .server_action_csrf_token
                                        .clone(),
                                    server_action_replay_nonce: None,
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
            None,
        )
    }
}

#[derive(Debug)]
pub struct ProductionProject {
    config: ProductionServerConfig,
    snapshot: OnceLock<ProductionRouteSnapshot>,
    replay_nonces: Option<Mutex<ProductionReplayNonces>>,
}

impl ProductionProject {
    #[cfg(test)]
    pub fn new(config: ProductionServerConfig) -> Self {
        let replay_nonces = config
            .server_action_replay_ttl
            .map(ProductionReplayNonces::new)
            .map(Mutex::new);
        Self {
            config,
            snapshot: OnceLock::new(),
            replay_nonces,
        }
    }

    pub fn from_artifact(mut config: ProductionServerConfig) -> Result<Self> {
        let artifact_root = config.artifact_root.as_ref().ok_or_else(|| {
            DevServerError::Artifact(ProductionArtifactError::Invalid(
                "artifact-backed production config is missing artifactRoot".to_owned(),
            ))
        })?;
        let loaded = load_production_artifact(artifact_root)?;
        config.artifact_root = Some(loaded.root.clone());
        config.artifact_build_id = Some(loaded.manifest.build_id.clone());
        config.client_out_dir = loaded.root.join("_ferrite/static");
        config.client_public_path = loaded.manifest.client_public_path.clone();

        let mut verified_files = loaded.verified_files;
        let verified_static_assets = loaded
            .manifest
            .files
            .iter()
            .filter_map(|file| {
                let relative = file.path.strip_prefix("_ferrite/static/")?;
                let bytes = verified_files
                    .remove(&file.path)
                    .expect("loaded artifact retains every verified file");
                Some((relative.to_owned(), Arc::<[u8]>::from(bytes)))
            })
            .collect();
        let mut client_bundles = BTreeMap::new();
        let mut server_module_sources = BTreeMap::new();
        let routes = loaded
            .manifest
            .routes
            .into_iter()
            .map(|route| {
                client_bundles.insert(route.path.clone(), route.client_bundle);
                let source = verified_files
                    .remove(&route.server_module)
                    .expect("loaded artifact retains every verified server module");
                server_module_sources.insert(route.path.clone(), Arc::<[u8]>::from(source));
                Route {
                    path: route.path,
                    file: loaded.root.join(route.server_module),
                    layouts: Vec::new(),
                    loading: None,
                    error: None,
                    params: route.params,
                }
            })
            .collect();
        let document_file = loaded
            .manifest
            .has_document
            .then(|| loaded.root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST));
        let replay_nonces = config
            .server_action_replay_ttl
            .map(ProductionReplayNonces::new)
            .map(Mutex::new);

        let snapshot = OnceLock::new();
        snapshot
            .set(ProductionRouteSnapshot {
                routes,
                document_file,
                client_bundles,
                server_module_sources,
                verified_static_assets: Some(verified_static_assets),
            })
            .expect("new production artifact snapshot is empty");

        Ok(Self {
            config,
            snapshot,
            replay_nonces,
        })
    }

    pub fn config(&self) -> &ProductionServerConfig {
        &self.config
    }

    pub fn routes(&self) -> Result<&[Route]> {
        self.ensure_ready()?;
        Ok(&self.snapshot.get().expect("snapshot just built").routes)
    }

    pub fn handle_get(&self, raw_path: &str) -> Result<DevResponse> {
        self.handle_get_with_context(raw_path, ProductionRequestContext::default())
    }

    fn handle_get_with_context(
        &self,
        raw_path: &str,
        request_context: ProductionRequestContext,
    ) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        let started = Instant::now();
        let response = self.handle_get_inner(raw_path)?;
        self.observe_request(
            "GET",
            raw_path,
            &response,
            started.elapsed(),
            request_context,
        );
        Ok(response)
    }

    pub fn handle_post(
        &self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
    ) -> Result<DevResponse> {
        self.handle_post_with_context(raw_path, headers, body, ProductionRequestContext::default())
    }

    fn handle_post_with_context(
        &self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
        request_context: ProductionRequestContext,
    ) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        let started = Instant::now();
        let response = self.handle_post_inner(raw_path, headers, body, &request_context)?;
        self.observe_request(
            "POST",
            raw_path,
            &response,
            started.elapsed(),
            request_context,
        );
        Ok(response)
    }

    fn handle_get_inner(&self, raw_path: &str) -> Result<DevResponse> {
        let path = strip_query(raw_path);
        if self.config.metrics_path.as_deref() == Some(path) {
            return Ok(DevResponse::ok(
                "text/plain; version=0.0.4; charset=utf-8",
                self.config.metrics.render(),
            )
            .with_cache_control("no-store"));
        }

        self.ensure_ready()?;

        if path.starts_with(&self.config.client_public_path) {
            let snapshot = self.snapshot.get().expect("snapshot built before response");
            return Ok(static_asset_response(
                path,
                &self.config.client_public_path,
                &self.config.client_out_dir,
                snapshot.verified_static_assets.as_ref(),
            )
            .with_cache_control(static_asset_cache_control(path)));
        }

        match route_response_mode(raw_path) {
            Ok(mode) => Ok(self.route_response(path, mode)),
            Err(message) => Ok(DevResponse::bad_request(message)),
        }
    }

    fn handle_post_inner(
        &self,
        raw_path: &str,
        headers: &HttpHeaders,
        body: &[u8],
        request_context: &ProductionRequestContext,
    ) -> Result<DevResponse> {
        self.ensure_ready()?;
        let path = strip_query(raw_path);
        if path != SERVER_ACTION_PATH {
            return Ok(DevResponse::method_not_allowed().with_cache_control("no-store"));
        }

        self.action_response(headers, body, request_context)
            .map(|response| response.with_cache_control("no-store"))
    }

    fn observe_request(
        &self,
        method: impl Into<String>,
        path: impl Into<String>,
        response: &DevResponse,
        elapsed: Duration,
        request_context: ProductionRequestContext,
    ) {
        let method = method.into();
        let path = path.into();
        self.config.metrics.record_request(
            &method,
            response.status,
            response.route_pattern_header.as_deref(),
        );
        if let Some(observer) = &self.config.request_observer {
            observer.observe(ProductionRequestEvent {
                method,
                path,
                status: response.status,
                route_pattern: response.route_pattern_header.clone(),
                client_ip: request_context.client_ip,
                elapsed,
            });
        }
    }

    fn request_context(
        &self,
        headers: &HttpHeaders,
        peer_ip: Option<IpAddr>,
    ) -> ProductionRequestContext {
        ProductionRequestContext {
            client_ip: production_client_ip(headers, peer_ip, &self.config),
        }
    }

    fn observe_action(
        &self,
        action_id: Option<String>,
        route_path: Option<String>,
        route_pattern: Option<String>,
        response: &DevResponse,
        elapsed: Duration,
        request_context: &ProductionRequestContext,
    ) {
        let outcome = if response.status < 400 {
            ProductionActionOutcome::Accepted
        } else {
            ProductionActionOutcome::Rejected
        };
        self.config
            .metrics
            .record_action(outcome, response.status, route_pattern.as_deref());
        if let Some(observer) = &self.config.action_observer {
            observer.observe(ProductionActionEvent {
                action_id,
                route_path,
                route_pattern,
                status: response.status,
                outcome,
                client_ip: request_context.client_ip.clone(),
                elapsed,
            });
        }
    }

    fn ensure_ready(&self) -> Result<()> {
        if self.snapshot.get().is_some() {
            return Ok(());
        }

        let routes = scan_app_dir(&self.config.app_dir)?;
        write_route_types(&routes, &self.config.types_out)?;
        if self.config.client_out_dir.exists() {
            fs::remove_dir_all(&self.config.client_out_dir)?;
        }
        let document_file = find_document_file(&self.config.app_dir);
        let _ = self.snapshot.set(ProductionRouteSnapshot {
            routes,
            document_file,
            client_bundles: BTreeMap::new(),
            server_module_sources: BTreeMap::new(),
            verified_static_assets: None,
        });
        Ok(())
    }

    fn route_response(&self, path: &str, mode: RouteResponseMode) -> DevResponse {
        let replay_nonce = match self.issue_server_action_replay_nonce() {
            Ok(replay_nonce) => replay_nonce,
            Err(response) => return *response,
        };
        let snapshot = self.snapshot.get().expect("snapshot built before response");

        let response = if let Some(match_result) = match_route(path, &snapshot.routes) {
            let module_source = snapshot
                .server_module_sources
                .get(&match_result.route.path)
                .cloned();
            let renderer = self.page_renderer(replay_nonce.as_deref(), module_source);
            let conventions = route_conventions(&match_result.route);
            let artifact_client_bundle = snapshot
                .client_bundles
                .get(&match_result.route.path)
                .cloned();
            match mode {
                RouteResponseMode::Html => match artifact_client_bundle.as_ref() {
                    Some(client_bundle) => self.artifact_route_stream_response(
                        path,
                        &match_result,
                        &renderer,
                        replay_nonce.as_deref(),
                        ProductionArtifactRouteContext {
                            document_file: snapshot.document_file.as_deref(),
                            conventions: &conventions,
                            client_bundle,
                        },
                    ),
                    None => self.route_stream_response(
                        path,
                        &match_result,
                        &renderer,
                        snapshot.document_file.as_deref(),
                        &conventions,
                        replay_nonce.as_deref(),
                    ),
                },
                RouteResponseMode::ServerPayloadJson => {
                    let options = ProductionServerPayloadOptions {
                        kind: ServerPayloadResponseKind::Json,
                        replay_nonce: replay_nonce.as_deref(),
                    };
                    match artifact_client_bundle.as_ref() {
                        Some(client_bundle) => self.artifact_route_server_payload_response(
                            path,
                            &match_result,
                            &renderer,
                            options,
                            ProductionArtifactRouteContext {
                                document_file: snapshot.document_file.as_deref(),
                                conventions: &conventions,
                                client_bundle,
                            },
                        ),
                        None => self.route_server_payload_response(
                            path,
                            &match_result,
                            &renderer,
                            snapshot.document_file.as_deref(),
                            &conventions,
                            options,
                        ),
                    }
                }
                RouteResponseMode::ServerPayloadStream => {
                    let options = ProductionServerPayloadOptions {
                        kind: ServerPayloadResponseKind::Stream,
                        replay_nonce: replay_nonce.as_deref(),
                    };
                    match artifact_client_bundle.as_ref() {
                        Some(client_bundle) => self.artifact_route_server_payload_response(
                            path,
                            &match_result,
                            &renderer,
                            options,
                            ProductionArtifactRouteContext {
                                document_file: snapshot.document_file.as_deref(),
                                conventions: &conventions,
                                client_bundle,
                            },
                        ),
                        None => self.route_server_payload_response(
                            path,
                            &match_result,
                            &renderer,
                            snapshot.document_file.as_deref(),
                            &conventions,
                            options,
                        ),
                    }
                }
            }
            .with_cache_control("no-store")
            .with_route_pattern(match_result.route.path)
        } else {
            DevResponse::not_found(render_production_not_found(path, &snapshot.routes))
                .with_cache_control("no-store")
        };
        self.with_server_action_csrf_cookie(response)
    }

    fn issue_server_action_replay_nonce(
        &self,
    ) -> std::result::Result<Option<String>, Box<DevResponse>> {
        match &self.replay_nonces {
            Some(replay_nonces) => replay_nonces
                .lock()
                .expect("production replay nonce mutex poisoned")
                .issue()
                .map(Some),
            None => Ok(None),
        }
    }

    fn with_server_action_csrf_cookie(&self, response: DevResponse) -> DevResponse {
        let (Some(name), Some(token)) = (
            self.config.server_action_csrf_cookie_name.as_deref(),
            self.config.server_action_csrf_token.as_deref(),
        ) else {
            return response;
        };
        match server_action_csrf_cookie_header(name, token) {
            Some(header) => response.with_set_cookie_header(header),
            None => response,
        }
    }

    fn page_renderer(
        &self,
        replay_nonce: Option<&str>,
        module_source: Option<Arc<[u8]>>,
    ) -> PageRenderer {
        let renderer = if self.config.artifact_root.is_some() {
            let renderer = PageRenderer::for_prebuilt_artifact(
                self.config.project.clone(),
                self.config.page_renderer.clone(),
            );
            renderer.with_prebuilt_module_source(
                module_source.expect("artifact route has verified server module bytes"),
            )
        } else {
            PageRenderer::new(
                self.config.project.clone(),
                self.config.page_renderer.clone(),
            )
        };
        let mut renderer = renderer.with_command_timeout(self.config.render_timeout);
        if let Some(token) = &self.config.server_action_csrf_token {
            renderer = renderer.with_server_action_csrf_token(token.clone());
        }
        if let Some(replay_nonce) = replay_nonce {
            renderer = renderer.with_server_action_replay_nonce(replay_nonce.to_owned());
        }
        renderer
    }

    fn action_response(
        &self,
        headers: &HttpHeaders,
        body: &[u8],
        request_context: &ProductionRequestContext,
    ) -> Result<DevResponse> {
        let started = Instant::now();
        let mut replay_nonces = self.replay_nonces.as_ref().map(|replay_nonces| {
            replay_nonces
                .lock()
                .expect("production replay nonce mutex poisoned")
        });
        let request = match server_action_request_from_form(
            headers,
            body,
            self.config.server_action_csrf_token.as_deref(),
            self.config.server_action_csrf_cookie_name.as_deref(),
            self.config.trusted_proxy.as_ref(),
            replay_nonces.as_deref_mut(),
        ) {
            Ok(request) => request,
            Err(response) => {
                let response = *response;
                self.observe_action(
                    None,
                    None,
                    None,
                    &response,
                    started.elapsed(),
                    request_context,
                );
                return Ok(response);
            }
        };
        drop(replay_nonces);
        let snapshot = self.snapshot.get().expect("snapshot built before response");
        let action_id = request.id.clone();
        let route_path = request.route_path.clone();
        let Some(match_result) = match_route(&route_path, &snapshot.routes) else {
            let response = DevResponse::not_found_text(format!(
                "No Ferrite route matched server action route `{route_path}`"
            ));
            self.observe_action(
                Some(action_id),
                Some(route_path),
                None,
                &response,
                started.elapsed(),
                request_context,
            );
            return Ok(response);
        };
        let module_source = snapshot
            .server_module_sources
            .get(&match_result.route.path)
            .cloned();
        let renderer = self.page_renderer(None, module_source);
        let conventions = route_conventions(&match_result.route);
        let response = match renderer.invoke_server_action(
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
        }?;
        self.observe_action(
            Some(action_id),
            Some(route_path),
            response.route_pattern_header.clone(),
            &response,
            started.elapsed(),
            request_context,
        );
        Ok(response)
    }

    fn artifact_route_stream_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        replay_nonce: Option<&str>,
        context: ProductionArtifactRouteContext<'_>,
    ) -> DevResponse {
        let ProductionArtifactRouteContext {
            document_file,
            conventions,
            client_bundle,
        } = context;
        match document_file {
            Some(document_file) => {
                let metadata = match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        return production_render_error_response(path, match_result, &error);
                    }
                };
                match renderer.render_document_to_stream_parts_with_conventions(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    document_file,
                    &match_result.params,
                    &DocumentRenderOptions {
                        root_id: "ferrite-root".to_owned(),
                        route_path: path.to_owned(),
                        route_pattern: Some(match_result.route.path.clone()),
                        build_id: None,
                        server_action_csrf_token: self.config.server_action_csrf_token.clone(),
                        server_action_replay_nonce: replay_nonce.map(str::to_owned),
                        metadata,
                        preload_scripts: client_bundle_scripts(client_bundle),
                        styles: client_bundle_styles(client_bundle),
                        scripts: client_bundle_scripts(client_bundle),
                        default_title: "Ferrite".to_owned(),
                    },
                    conventions,
                ) {
                    Ok(parts) => DevResponse::streaming_html(
                        parts.shell,
                        parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                    )
                    .with_modulepreload_links(client_bundle_scripts(client_bundle)),
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
                        let shell = render_production_route_document(
                            path,
                            match_result,
                            &parts.shell,
                            client_bundle,
                            &metadata,
                        );
                        DevResponse::streaming_html(
                            shell,
                            parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                        )
                        .with_modulepreload_links(client_bundle_scripts(client_bundle))
                    }
                    Err(error) => production_render_error_response(path, match_result, &error),
                },
                Err(error) => production_render_error_response(path, match_result, &error),
            },
        }
    }

    fn artifact_route_server_payload_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        options: ProductionServerPayloadOptions<'_>,
        context: ProductionArtifactRouteContext<'_>,
    ) -> DevResponse {
        let ProductionArtifactRouteContext {
            document_file,
            conventions,
            client_bundle,
        } = context;
        match document_file {
            Some(document_file) => {
                let metadata = match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        return production_render_error_response(path, match_result, &error);
                    }
                };
                match renderer.render_document_to_server_payload_json_with_conventions(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    document_file,
                    &match_result.params,
                    &DocumentRenderOptions {
                        root_id: "ferrite-root".to_owned(),
                        route_path: path.to_owned(),
                        route_pattern: Some(match_result.route.path.clone()),
                        build_id: None,
                        server_action_csrf_token: self.config.server_action_csrf_token.clone(),
                        server_action_replay_nonce: options.replay_nonce.map(str::to_owned),
                        metadata,
                        preload_scripts: client_bundle_scripts(client_bundle),
                        styles: client_bundle_styles(client_bundle),
                        scripts: client_bundle_scripts(client_bundle),
                        default_title: "Ferrite".to_owned(),
                    },
                    conventions,
                ) {
                    Ok(payload) => server_payload_response(payload, options.kind),
                    Err(error) => production_render_error_response(path, match_result, &error),
                }
            }
            None => match renderer.render_page_to_server_payload_json_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(payload) => server_payload_response(payload, options.kind),
                Err(error) => production_render_error_response(path, match_result, &error),
            },
        }
    }

    fn route_stream_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        document_file: Option<&Path>,
        conventions: &RouteConventions,
        replay_nonce: Option<&str>,
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
                        )
                        .with_command_timeout(self.config.render_timeout);
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
                                options: ClientBundleOptions {
                                    action_bootstrap,
                                    runtime_props: false,
                                },
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
                                        server_action_csrf_token: self
                                            .config
                                            .server_action_csrf_token
                                            .clone(),
                                        server_action_replay_nonce: replay_nonce.map(str::to_owned),
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
                            Err(error) => {
                                production_bundle_error_response(path, match_result, &error)
                            }
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
                        )
                        .with_command_timeout(self.config.render_timeout);
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
                                options: ClientBundleOptions {
                                    action_bootstrap,
                                    runtime_props: false,
                                },
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
                            Err(error) => {
                                production_bundle_error_response(path, match_result, &error)
                            }
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
        options: ProductionServerPayloadOptions<'_>,
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
                        )
                        .with_command_timeout(self.config.render_timeout);
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
                                options: ClientBundleOptions {
                                    action_bootstrap,
                                    runtime_props: false,
                                },
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
                                        server_action_csrf_token: self
                                            .config
                                            .server_action_csrf_token
                                            .clone(),
                                        server_action_replay_nonce: options
                                            .replay_nonce
                                            .map(str::to_owned),
                                        metadata: metadata.clone(),
                                        preload_scripts: client_bundle_scripts(&client_bundle),
                                        styles: client_bundle_styles(&client_bundle),
                                        scripts: client_bundle_scripts(&client_bundle),
                                        default_title: "Ferrite".to_owned(),
                                    },
                                    conventions,
                                ) {
                                Ok(payload) => server_payload_response(payload, options.kind),
                                Err(error) => {
                                    production_render_error_response(path, match_result, &error)
                                }
                            },
                            Err(error) => {
                                production_bundle_error_response(path, match_result, &error)
                            }
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
                Ok(payload) => server_payload_response(payload, options.kind),
                Err(error) => production_render_error_response(path, match_result, &error),
            },
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ProductionRequestContext {
    client_ip: Option<String>,
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
    pub set_cookie_headers: Vec<String>,
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
        }
    }

    pub fn service_unavailable() -> Self {
        Self {
            status: 503,
            reason: "Service Unavailable",
            content_type: "text/plain; charset=utf-8",
            body: b"Service Unavailable\n".to_vec(),
            stream: None,
            cache_control: Some("no-store"),
            route_pattern_header: None,
            link_headers: Vec::new(),
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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
            set_cookie_headers: Vec::new(),
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

    pub fn with_set_cookie_header(mut self, value: impl Into<String>) -> Self {
        self.set_cookie_headers.push(value.into());
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
    overload_sender: mpsc::SyncSender<TcpStream>,
    overload_workers: Vec<thread::JoinHandle<()>>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: usize,
    response_write_timeout: Duration,
    max_request_bytes: usize,
}

struct ProductionInFlightGuard(Arc<AtomicUsize>);

impl Drop for ProductionInFlightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ProductionWorkerPool {
    fn new(worker_count: usize, project: Arc<ProductionProject>) -> Self {
        let worker_count = worker_count.max(1);
        let request_read_timeout = project.config.request_read_timeout;
        let response_write_timeout = project.config.response_write_timeout;
        let max_request_bytes = project.config.max_request_bytes;
        let (sender, receiver) = mpsc::channel::<TcpStream>();
        let receiver = Arc::new(Mutex::new(receiver));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(worker_count);
        let overload_worker_count = worker_count.min(MAX_PRODUCTION_OVERLOAD_WORKERS);
        let (overload_sender, overload_receiver) =
            mpsc::sync_channel::<TcpStream>(worker_count.saturating_mul(2));
        let overload_receiver = Arc::new(Mutex::new(overload_receiver));
        let mut overload_workers = Vec::with_capacity(overload_worker_count);

        for _ in 0..worker_count {
            let receiver = Arc::clone(&receiver);
            let project = Arc::clone(&project);
            let in_flight = Arc::clone(&in_flight);
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
                    let _in_flight_guard = ProductionInFlightGuard(Arc::clone(&in_flight));
                    if let Err(error) = handle_production_stream_concurrent(&mut stream, &project)
                        && is_response_write_deadline_error(&error)
                    {
                        eprintln!("Ferrite production response write deadline exceeded");
                    }
                }
            }));
        }

        for _ in 0..overload_worker_count {
            let receiver = Arc::clone(&overload_receiver);
            overload_workers.push(thread::spawn(move || {
                loop {
                    let stream = {
                        let receiver = receiver
                            .lock()
                            .expect("production overload receiver mutex poisoned");
                        receiver.recv()
                    };
                    let Ok(stream) = stream else {
                        break;
                    };
                    reject_overloaded_stream(
                        stream,
                        request_read_timeout,
                        response_write_timeout,
                        max_request_bytes,
                    );
                }
            }));
        }

        Self {
            sender,
            workers,
            overload_sender,
            overload_workers,
            in_flight,
            max_in_flight: worker_count,
            response_write_timeout,
            max_request_bytes,
        }
    }

    fn send(&self, stream: TcpStream) -> Result<()> {
        stream.set_nonblocking(false)?;
        let reserved = self
            .in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.max_in_flight).then_some(current + 1)
            })
            .is_ok();
        if !reserved {
            return match self.overload_sender.try_send(stream) {
                Ok(()) => Ok(()),
                Err(mpsc::TrySendError::Full(stream)) => {
                    reject_overloaded_stream_without_wait(
                        stream,
                        self.response_write_timeout,
                        self.max_request_bytes,
                    );
                    Ok(())
                }
                Err(mpsc::TrySendError::Disconnected(_stream)) => {
                    Err(DevServerError::Io(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "production overload worker pool is closed",
                    )))
                }
            };
        }

        self.sender.send(stream).map_err(|_| {
            self.in_flight.fetch_sub(1, Ordering::AcqRel);
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

    #[cfg(test)]
    fn overload_worker_count(&self) -> usize {
        self.overload_workers.len()
    }

    #[cfg(test)]
    fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    fn shutdown(self) {
        let Self {
            sender,
            workers,
            overload_sender,
            overload_workers,
            ..
        } = self;
        drop(sender);
        drop(overload_sender);
        for worker in workers {
            let _ = worker.join();
        }
        for worker in overload_workers {
            let _ = worker.join();
        }
    }
}

fn reject_overloaded_stream(
    mut stream: TcpStream,
    request_read_timeout: Duration,
    response_write_timeout: Duration,
    max_request_bytes: usize,
) {
    let _ = write_overload_response(&mut stream, response_write_timeout);
    let _ = stream.shutdown(Shutdown::Write);
    let _ = drain_overload_request(
        &mut stream,
        request_read_timeout
            .min(PRODUCTION_OVERLOAD_REQUEST_DRAIN_TIMEOUT)
            .max(MIN_PRODUCTION_REQUEST_READ_TIMEOUT),
        max_request_bytes,
    );
    let _ = stream.shutdown(Shutdown::Read);
}

fn reject_overloaded_stream_without_wait(
    mut stream: TcpStream,
    response_write_timeout: Duration,
    max_request_bytes: usize,
) {
    let _ = stream.set_nonblocking(true);
    let _ = write_overload_response(&mut stream, response_write_timeout);
    let _ = stream.shutdown(Shutdown::Write);
    let _ = drain_available_overload_request(&mut stream, max_request_bytes);
    let _ = stream.shutdown(Shutdown::Read);
}

fn write_overload_response(stream: &mut TcpStream, response_write_timeout: Duration) -> Result<()> {
    write_response_with_options(
        stream,
        &DevResponse::service_unavailable(),
        ResponseWriteOptions {
            gzip: false,
            deadline: Some(response_write_timeout.min(PRODUCTION_OVERLOAD_WRITE_TIMEOUT)),
        },
    )
}

fn drain_overload_request(
    stream: &mut TcpStream,
    timeout: Duration,
    max_request_bytes: usize,
) -> std::io::Result<()> {
    let deadline = Instant::now() + timeout;
    let max_request_bytes = max_request_bytes.max(1);
    let mut drained = 0;
    let mut buffer = [0_u8; 1024];
    stream.set_nonblocking(true)?;
    let result = loop {
        let remaining = max_request_bytes.saturating_sub(drained);
        if remaining == 0 || Instant::now() >= deadline {
            break Ok(());
        }
        let read_len = remaining.min(buffer.len());
        match stream.read(&mut buffer[..read_len]) {
            Ok(0) => break Ok(()),
            Ok(read) => drained += read,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => break Err(error),
        }
    };
    let blocking = stream.set_nonblocking(false);
    result.and(blocking)
}

fn drain_available_overload_request(
    stream: &mut TcpStream,
    max_request_bytes: usize,
) -> std::io::Result<()> {
    let max_request_bytes = max_request_bytes.max(1);
    let mut drained = 0;
    let mut buffer = [0_u8; 1024];
    loop {
        let remaining = max_request_bytes.saturating_sub(drained);
        if remaining == 0 {
            return Ok(());
        }
        let read_len = remaining.min(buffer.len());
        match stream.read(&mut buffer[..read_len]) {
            Ok(0) => return Ok(()),
            Ok(read) => drained += read,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
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
    client_bundles: BTreeMap<String, ClientBundle>,
    server_module_sources: BTreeMap<String, Arc<[u8]>>,
    verified_static_assets: Option<BTreeMap<String, Arc<[u8]>>>,
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

#[derive(Debug, Clone, Copy)]
struct ProductionServerPayloadOptions<'a> {
    kind: ServerPayloadResponseKind,
    replay_nonce: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
struct ProductionArtifactRouteContext<'a> {
    document_file: Option<&'a Path>,
    conventions: &'a RouteConventions,
    client_bundle: &'a ClientBundle,
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

pub fn serve_production<A: ToSocketAddrs>(addr: A, project: ProductionProject) -> Result<()> {
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

pub fn serve_production_listener(listener: TcpListener, project: &ProductionProject) -> Result<()> {
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
    let project = Arc::new(project);
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
    project: &ProductionProject,
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

fn handle_production_stream(stream: &mut TcpStream, project: &ProductionProject) -> Result<()> {
    let request_read_timeout = project.config.request_read_timeout;
    let response_write_timeout = project.config.response_write_timeout;
    let max_request_bytes = project.config.max_request_bytes;
    let peer_ip = stream.peer_addr().ok().map(|addr| addr.ip());
    handle_production_stream_with_limits(
        stream,
        request_read_timeout,
        response_write_timeout,
        max_request_bytes,
        |request| match request.method.as_str() {
            "GET" => {
                let context = project.request_context(&request.headers, peer_ip);
                project.handle_get_with_context(&request.path, context)
            }
            "POST" => {
                let context = project.request_context(&request.headers, peer_ip);
                project.handle_post_with_context(
                    &request.path,
                    &request.headers,
                    &request.body,
                    context,
                )
            }
            _ => Ok(DevResponse::method_not_allowed()),
        },
    )
}

fn handle_production_stream_concurrent(
    stream: &mut TcpStream,
    project: &Arc<ProductionProject>,
) -> Result<()> {
    let peer_ip = stream.peer_addr().ok().map(|addr| addr.ip());
    let request_read_timeout = project.config.request_read_timeout;
    let response_write_timeout = project.config.response_write_timeout;
    let max_request_bytes = project.config.max_request_bytes;
    handle_production_stream_with_limits(
        stream,
        request_read_timeout,
        response_write_timeout,
        max_request_bytes,
        |request| match request.method.as_str() {
            "GET" => {
                let context = project.request_context(&request.headers, peer_ip);
                project.handle_get_with_context(&request.path, context)
            }
            "POST" => {
                let context = project.request_context(&request.headers, peer_ip);
                project.handle_post_with_context(
                    &request.path,
                    &request.headers,
                    &request.body,
                    context,
                )
            }
            _ => Ok(DevResponse::method_not_allowed()),
        },
    )
}

fn handle_production_stream_with_limits<F>(
    stream: &mut TcpStream,
    request_read_timeout: Duration,
    response_write_timeout: Duration,
    max_request_bytes: usize,
    mut handle_request: F,
) -> Result<()>
where
    F: FnMut(&ParsedHttpRequest) -> Result<DevResponse>,
{
    stream.set_read_timeout(Some(
        request_read_timeout.max(MIN_PRODUCTION_REQUEST_READ_TIMEOUT),
    ))?;
    let response_write_timeout = response_write_timeout.max(MIN_PRODUCTION_RESPONSE_WRITE_TIMEOUT);
    let request = match read_http_request(stream, max_request_bytes)? {
        RequestReadResult::Request(request) => request,
        RequestReadResult::Response(response) => {
            write_response_with_options(
                stream,
                &response,
                ResponseWriteOptions {
                    gzip: false,
                    deadline: Some(response_write_timeout),
                },
            )?;
            return Ok(());
        }
    };
    let write_options = ResponseWriteOptions {
        gzip: request.accepts_gzip(),
        deadline: Some(response_write_timeout),
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
    deadline: Option<Duration>,
}

fn write_response_with_options(
    stream: &mut TcpStream,
    response: &DevResponse,
    options: ResponseWriteOptions,
) -> Result<()> {
    match options.deadline {
        Some(timeout) => {
            let mut writer = ResponseDeadlineWriter::new(stream, timeout);
            write_response_to(&mut writer, response, options.gzip)
        }
        None => write_response_to(stream, response, options.gzip),
    }
}

struct ResponseDeadlineWriter<'a> {
    stream: &'a mut TcpStream,
    started: Instant,
    timeout: Duration,
}

impl<'a> ResponseDeadlineWriter<'a> {
    fn new(stream: &'a mut TcpStream, timeout: Duration) -> Self {
        Self {
            stream,
            started: Instant::now(),
            timeout: timeout.max(MIN_PRODUCTION_RESPONSE_WRITE_TIMEOUT),
        }
    }

    fn remaining(&self) -> std::io::Result<Duration> {
        self.timeout
            .checked_sub(self.started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(response_write_deadline_error)
    }
}

impl Write for ResponseDeadlineWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let remaining = self.remaining()?;
        self.stream.set_write_timeout(Some(remaining))?;
        self.stream.write(bytes).map_err(map_response_write_error)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let remaining = self.remaining()?;
        self.stream.set_write_timeout(Some(remaining))?;
        self.stream.flush().map_err(map_response_write_error)
    }
}

fn response_write_deadline_error() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        PRODUCTION_RESPONSE_WRITE_DEADLINE_MESSAGE,
    )
}

fn is_response_write_deadline_error(error: &DevServerError) -> bool {
    matches!(
        error,
        DevServerError::Io(error)
            if error.kind() == std::io::ErrorKind::TimedOut
                && error.to_string() == PRODUCTION_RESPONSE_WRITE_DEADLINE_MESSAGE
    )
}

fn map_response_write_error(error: std::io::Error) -> std::io::Error {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ) {
        response_write_deadline_error()
    } else {
        error
    }
}

fn write_response_to<W: Write>(stream: &mut W, response: &DevResponse, gzip: bool) -> Result<()> {
    let should_gzip = gzip && is_gzip_eligible(response);

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

fn write_response_compression_headers<W: Write>(stream: &mut W, gzip: bool) -> Result<()> {
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

fn write_response_metadata_headers<W: Write>(stream: &mut W, response: &DevResponse) -> Result<()> {
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

    for cookie in &response.set_cookie_headers {
        write!(stream, "Set-Cookie: {}\r\n", sanitize_header_value(cookie))?;
    }

    Ok(())
}

fn sanitize_header_value(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn write_chunk<W: Write>(stream: &mut W, bytes: &[u8]) -> Result<()> {
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
    expected_csrf_token: Option<&str>,
    csrf_cookie_name: Option<&str>,
    trusted_proxy: Option<&ProductionTrustedProxyConfig>,
    replay_nonces: Option<&mut ProductionReplayNonces>,
) -> std::result::Result<ServerActionRequest, Box<DevResponse>> {
    enforce_server_action_origin(headers, trusted_proxy)?;
    let mut form = parse_server_action_form(headers, body)
        .map_err(|message| Box::new(DevResponse::bad_request(message)))?;
    let id = remove_required_action_field(&mut form, SERVER_ACTION_ID_FIELD)?;
    let route_path = remove_required_action_field(&mut form, SERVER_ACTION_ROUTE_FIELD)?;
    enforce_server_action_csrf_token(&mut form, headers, expected_csrf_token, csrf_cookie_name)?;
    enforce_server_action_replay_nonce(&mut form, replay_nonces)?;
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

fn enforce_server_action_csrf_token(
    form: &mut BTreeMap<String, ServerActionFormValue>,
    headers: &HttpHeaders,
    expected_token: Option<&str>,
    cookie_name: Option<&str>,
) -> std::result::Result<(), Box<DevResponse>> {
    let Some(expected_token) = expected_token else {
        form.remove(SERVER_ACTION_CSRF_FIELD);
        if cookie_name.is_some() {
            return Err(Box::new(DevResponse::forbidden(
                "server action CSRF cookie binding requires a configured token",
            )));
        }
        return Ok(());
    };

    let received_token =
        remove_required_action_field(form, SERVER_ACTION_CSRF_FIELD).map_err(|_| {
            Box::new(DevResponse::forbidden(
                "server action CSRF token is required",
            ))
        })?;
    if !constant_time_eq(received_token.as_bytes(), expected_token.as_bytes()) {
        return Err(Box::new(DevResponse::forbidden(
            "server action CSRF token is invalid",
        )));
    }

    if let Some(cookie_name) = cookie_name {
        let Some(cookie_token) = server_action_cookie_value(headers, cookie_name) else {
            return Err(Box::new(DevResponse::forbidden(
                "server action CSRF cookie is required",
            )));
        };
        if !constant_time_eq(cookie_token.as_bytes(), expected_token.as_bytes()) {
            return Err(Box::new(DevResponse::forbidden(
                "server action CSRF cookie is invalid",
            )));
        }
    }

    Ok(())
}

fn enforce_server_action_replay_nonce(
    form: &mut BTreeMap<String, ServerActionFormValue>,
    replay_nonces: Option<&mut ProductionReplayNonces>,
) -> std::result::Result<(), Box<DevResponse>> {
    let Some(replay_nonces) = replay_nonces else {
        form.remove(SERVER_ACTION_REPLAY_NONCE_FIELD);
        return Ok(());
    };

    let received_nonce = remove_required_action_field(form, SERVER_ACTION_REPLAY_NONCE_FIELD)
        .map_err(|_| {
            Box::new(DevResponse::forbidden(
                "server action replay nonce is required",
            ))
        })?;
    if !replay_nonces.consume(&received_nonce) {
        return Err(Box::new(DevResponse::forbidden(
            "server action replay nonce is invalid or already used",
        )));
    }
    Ok(())
}

fn server_action_cookie_value(headers: &HttpHeaders, cookie_name: &str) -> Option<String> {
    let header = headers.get("cookie")?;
    for part in header.split(';') {
        let Some((name, value)) = part.trim().split_once('=') else {
            continue;
        };
        if name.trim() == cookie_name {
            let value = value.trim();
            return Some(
                value
                    .strip_prefix('"')
                    .and_then(|value| value.strip_suffix('"'))
                    .unwrap_or(value)
                    .to_owned(),
            );
        }
    }
    None
}

fn server_action_csrf_cookie_header(name: &str, token: &str) -> Option<String> {
    if !is_valid_cookie_name(name) || !is_valid_cookie_value(token) {
        return None;
    }
    Some(format!(
        "{name}={token}; {SERVER_ACTION_CSRF_COOKIE_ATTRIBUTES}"
    ))
}

fn is_valid_cookie_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| matches!(byte, b'!' | b'#'..=b'\'' | b'*' | b'+' | b'-' | b'.' | b'0'..=b'9' | b'A'..=b'Z' | b'^' | b'_' | b'`' | b'a'..=b'z' | b'|' | b'~'))
}

fn is_valid_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(
            |byte| matches!(byte, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e),
        )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    let mut diff = 0;
    for (left, right) in left.iter().zip(right) {
        diff |= left ^ right;
    }
    diff == 0
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpOrigin {
    scheme: String,
    authority: String,
}

impl fmt::Display for HttpOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}://{}", self.scheme, self.authority)
    }
}

enum ServerActionOriginExpectation {
    HostAuthority(String),
    TrustedProxyOrigin(HttpOrigin),
}

fn enforce_server_action_origin(
    headers: &HttpHeaders,
    trusted_proxy: Option<&ProductionTrustedProxyConfig>,
) -> std::result::Result<(), Box<DevResponse>> {
    let Some(host_header) = header_value(headers, "host") else {
        return Err(Box::new(DevResponse::forbidden(
            "server action Host header is required",
        )));
    };
    let Some(host) = normalize_authority(host_header) else {
        return Err(Box::new(DevResponse::forbidden(
            "server action Host must be a valid HTTP authority",
        )));
    };
    let expectation = match trusted_proxy {
        Some(config) => {
            enforce_trusted_proxy_forwarded_origin(headers, &config.public_origin)?;
            ServerActionOriginExpectation::TrustedProxyOrigin(config.public_origin.clone())
        }
        None => ServerActionOriginExpectation::HostAuthority(host),
    };

    if let Some(origin) = non_empty_header(headers, "origin") {
        let Some(origin) = http_header_origin(origin) else {
            return Err(Box::new(DevResponse::forbidden(
                "server action Origin must be an absolute HTTP(S) origin",
            )));
        };
        if !server_action_origin_matches(&origin, &expectation) {
            return Err(Box::new(DevResponse::forbidden(
                "server action Origin does not match the trusted request origin",
            )));
        }
    }

    if let Some(referer) = non_empty_header(headers, "referer") {
        let Some(referer_origin) = http_header_url_origin(referer) else {
            return Err(Box::new(DevResponse::forbidden(
                "server action Referer must be an absolute HTTP(S) URL",
            )));
        };
        if !server_action_origin_matches(&referer_origin, &expectation) {
            return Err(Box::new(DevResponse::forbidden(
                "server action Referer does not match the trusted request origin",
            )));
        }
    }

    Ok(())
}

fn enforce_trusted_proxy_forwarded_origin(
    headers: &HttpHeaders,
    expected: &HttpOrigin,
) -> std::result::Result<(), Box<DevResponse>> {
    let Some(forwarded_proto) = first_forwarded_header_value(headers, "x-forwarded-proto") else {
        return Err(Box::new(DevResponse::forbidden(
            "server action X-Forwarded-Proto is required for trusted proxy mode",
        )));
    };
    let forwarded_proto = forwarded_proto.to_ascii_lowercase();
    if forwarded_proto != expected.scheme {
        return Err(Box::new(DevResponse::forbidden(
            "server action X-Forwarded-Proto does not match the trusted public origin",
        )));
    }

    let Some(forwarded_host) = first_forwarded_header_value(headers, "x-forwarded-host") else {
        return Err(Box::new(DevResponse::forbidden(
            "server action X-Forwarded-Host is required for trusted proxy mode",
        )));
    };
    let Some(forwarded_host) = normalize_authority(forwarded_host) else {
        return Err(Box::new(DevResponse::forbidden(
            "server action X-Forwarded-Host must be a valid HTTP authority",
        )));
    };
    if forwarded_host != expected.authority {
        return Err(Box::new(DevResponse::forbidden(
            "server action X-Forwarded-Host does not match the trusted public origin",
        )));
    }

    Ok(())
}

fn server_action_origin_matches(
    origin: &HttpOrigin,
    expectation: &ServerActionOriginExpectation,
) -> bool {
    match expectation {
        ServerActionOriginExpectation::HostAuthority(authority) => &origin.authority == authority,
        ServerActionOriginExpectation::TrustedProxyOrigin(expected) => origin == expected,
    }
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

fn first_forwarded_header_value<'a>(headers: &'a HttpHeaders, name: &str) -> Option<&'a str> {
    non_empty_header(headers, name)
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn production_client_ip(
    headers: &HttpHeaders,
    peer_ip: Option<IpAddr>,
    config: &ProductionServerConfig,
) -> Option<String> {
    let Some(trusted_hops) = config.trusted_proxy_client_ip_hops else {
        return peer_ip.map(|ip| ip.to_string());
    };
    forwarded_client_ip(headers, trusted_hops).or_else(|| peer_ip.map(|ip| ip.to_string()))
}

fn forwarded_client_ip(headers: &HttpHeaders, trusted_hops: usize) -> Option<String> {
    let value = non_empty_header(headers, "x-forwarded-for")?;
    let ips = value
        .split(',')
        .map(str::trim)
        .map(str::parse::<IpAddr>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    let trusted_hops = trusted_hops.max(1);
    if ips.len() < trusted_hops {
        return None;
    }
    ips.get(ips.len() - trusted_hops).map(|ip| ip.to_string())
}

fn http_header_origin(value: &str) -> Option<HttpOrigin> {
    let trimmed = value.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let scheme = normalize_http_scheme(scheme)?;
    if rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return None;
    }
    let authority = normalize_authority(rest)?;
    Some(HttpOrigin { scheme, authority })
}

fn http_header_url_origin(value: &str) -> Option<HttpOrigin> {
    let trimmed = value.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let scheme = normalize_http_scheme(scheme)?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|authority| !authority.is_empty())?;
    let authority = normalize_authority(authority)?;
    Some(HttpOrigin { scheme, authority })
}

fn normalize_http_scheme(value: &str) -> Option<String> {
    if value.eq_ignore_ascii_case("http") || value.eq_ignore_ascii_case("https") {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
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

fn static_asset_response(
    path: &str,
    public_path: &str,
    out_dir: &Path,
    verified_assets: Option<&BTreeMap<String, Arc<[u8]>>>,
) -> DevResponse {
    let Some(relative) = path
        .strip_prefix(public_path)
        .and_then(|suffix| suffix.strip_prefix('/'))
    else {
        return DevResponse::not_found("not found\n".to_owned());
    };
    if relative.is_empty()
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return DevResponse::bad_request("invalid static asset path");
    }
    let file = out_dir.join(relative);
    if let Some(assets) = verified_assets {
        return match assets.get(relative) {
            Some(bytes) => DevResponse::ok(content_type_for(&file), bytes.as_ref().to_vec()),
            None => DevResponse::not_found("not found\n".to_owned()),
        };
    }
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
    let page_props = serde_json::to_string(&json!({
        "params": match_result
            .params
            .iter()
            .cloned()
            .collect::<BTreeMap<_, _>>()
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
  <div id="ferrite-root" data-route="{path}"{route_pattern} data-ferrite-page-props="{page_props}">{page_html}</div>
</body>
</html>"#,
        metadata_tags = metadata_tags,
        preloads = preloads,
        path = escape_html(path),
        route_pattern = route_pattern,
        page_props = escape_html(&page_props),
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
    eprintln!(
        "Ferrite production render failed: path={path:?} pattern={:?} error={:?}",
        match_result.route.path,
        error.to_string()
    );
    match error {
        PageRenderError::TimedOut { .. } => {
            DevResponse::gateway_timeout(render_production_render_error(504, path, match_result))
        }
        _ => DevResponse::internal_error(render_production_render_error(500, path, match_result)),
    }
}

fn render_production_render_error(status: u16, path: &str, match_result: &RouteMatch) -> String {
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
    <p>Ferrite could not render this route.</p>
  </main>
</body>
</html>"#,
        title = title,
        status = status,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
    )
}

fn production_bundle_error_response(
    path: &str,
    match_result: &RouteMatch,
    error: &ClientBundleError,
) -> DevResponse {
    eprintln!(
        "Ferrite production bundle failed: path={path:?} pattern={:?} error={:?}",
        match_result.route.path,
        error.to_string()
    );
    match error {
        ClientBundleError::TimedOut { .. } => {
            DevResponse::gateway_timeout(render_production_bundle_error(504, path, match_result))
        }
        _ => DevResponse::internal_error(render_production_bundle_error(500, path, match_result)),
    }
}

fn render_production_bundle_error(status: u16, path: &str, match_result: &RouteMatch) -> String {
    let title = if status == 504 {
        "Ferrite - Bundle Timeout"
    } else {
        "Ferrite - Bundle Error"
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{title}</title></head>
<body>
  <main id="ferrite-root" data-route="{path}" data-route-pattern="{pattern}">
    <h1>{status}</h1>
    <p>Ferrite could not prepare this route.</p>
  </main>
</body>
</html>"#,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        status = status,
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
    use ferrite_builder::{
        BuildConfig, ProductionArtifactManifest, ProductionArtifactRoute, artifact_file_record,
        build_project,
    };
    use ferrite_protocol::{ServerActionFormValue, ServerPayloadPacket};
    use flate2::read::GzDecoder;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::Barrier;
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

    fn action_form_body_with_csrf(route: &str, token: &str) -> Vec<u8> {
        format!(
            "__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route={}&__ferrite_csrf={token}&title=Hello+Ferrite&tag=rust&tag=tsx",
            route.replace('/', "%2F")
        )
        .into_bytes()
    }

    fn action_form_body_with_csrf_and_nonce(route: &str, token: &str, nonce: &str) -> Vec<u8> {
        format!(
            "__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route={}&__ferrite_csrf={token}&__ferrite_nonce={nonce}&title=Hello+Ferrite&tag=rust&tag=tsx",
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
            let project = project;
            serve_production_listener_once(listener, &project).unwrap();
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
        stream.shutdown(Shutdown::Write).unwrap();
        String::from_utf8(read_http_response(&mut stream).unwrap()).unwrap()
    }

    fn request_to_addr_with_timeout(
        addr: std::net::SocketAddr,
        request: &[u8],
        timeout: Duration,
    ) -> String {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(timeout)).unwrap();
        stream.write_all(request).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        String::from_utf8(read_http_response(&mut stream).unwrap()).unwrap()
    }

    fn concurrent_requests_to_addr(
        addr: std::net::SocketAddr,
        request: &'static [u8],
        count: usize,
        timeout: Duration,
    ) -> Vec<String> {
        let barrier = Arc::new(Barrier::new(count + 1));
        let clients = (0..count)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    request_to_addr_with_timeout(addr, request, timeout)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        clients
            .into_iter()
            .map(|client| client.join().unwrap())
            .collect()
    }

    fn response_status(response: &str) -> u16 {
        response
            .split_whitespace()
            .nth(1)
            .expect("HTTP response status")
            .parse()
            .expect("numeric HTTP response status")
    }

    fn peek_response_status(stream: &TcpStream, timeout: Duration) -> std::io::Result<u16> {
        let deadline = Instant::now() + timeout;
        stream.set_nonblocking(true)?;
        let result = loop {
            let mut prefix = [0_u8; 64];
            match stream.peek(&mut prefix) {
                Ok(0) => {
                    break Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "connection closed before an HTTP status arrived",
                    ));
                }
                Ok(read) => {
                    let prefix = String::from_utf8_lossy(&prefix[..read]);
                    if let Some(status) = prefix
                        .split_whitespace()
                        .nth(1)
                        .and_then(|status| status.parse::<u16>().ok())
                    {
                        break Ok(status);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => break Err(error),
            }
            if Instant::now() >= deadline {
                break Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "timed out waiting for an HTTP status",
                ));
            }
            thread::sleep(Duration::from_millis(1));
        };
        stream.set_nonblocking(false)?;
        result
    }

    fn connect_admitted_slow_reader(
        addr: std::net::SocketAddr,
        request: &[u8],
        timeout: Duration,
    ) -> TcpStream {
        let deadline = Instant::now() + timeout;
        loop {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.set_read_timeout(Some(timeout)).unwrap();
            stream.write_all(request).unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
            match peek_response_status(&stream, timeout).unwrap() {
                200 => return stream,
                503 => {
                    assert!(Instant::now() < deadline, "slow reader was never admitted");
                    thread::sleep(Duration::from_millis(5));
                }
                408 => panic!("complete slow-reader request received a false 408"),
                status => panic!("slow-reader admission returned unexpected status {status}"),
            }
        }
    }

    fn read_http_response(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
        let mut response = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            if http_response_is_complete(&response) {
                return Ok(response);
            }
            match stream.read(&mut buffer) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "connection closed before the HTTP response was complete",
                    ));
                }
                Ok(read) => response.extend_from_slice(&buffer[..read]),
                Err(error) => return Err(error),
            }
        }
    }

    fn http_response_is_complete(response: &[u8]) -> bool {
        let Some(header_end) = find_header_end(response) else {
            return false;
        };
        let headers = String::from_utf8_lossy(&response[..header_end]);
        let body = &response[header_end + 4..];
        for line in headers.lines().skip(1) {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.eq_ignore_ascii_case("content-length") {
                return value
                    .trim()
                    .parse::<usize>()
                    .is_ok_and(|expected| body.len() >= expected);
            }
            if name.eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
            {
                return body.ends_with(b"0\r\n\r\n");
            }
        }
        false
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
        let deadline = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_directory_entries(path: &Path, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let entries = fs::read_dir(path)
                .map(|entries| entries.count())
                .unwrap_or_default();
            if entries >= expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {expected} entries in {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn artifact_production_project_with_runner(
        project: &Path,
        runner_body: &str,
    ) -> ProductionProject {
        artifact_production_project_with_runner_and_asset(project, runner_body, None)
    }

    fn artifact_production_project_with_runner_and_asset(
        project: &Path,
        runner_body: &str,
        asset: Option<(&str, &[u8])>,
    ) -> ProductionProject {
        let artifact_root = project.join("artifact");
        write(
            &artifact_root.join("server/route.mjs"),
            "export const routePattern = '/';\n",
        );
        let mut files = vec![artifact_file_record(&artifact_root, "server/route.mjs").unwrap()];
        if let Some((relative_path, bytes)) = asset {
            let path = artifact_root.join("_ferrite/static").join(relative_path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            files.push(
                artifact_file_record(&artifact_root, &format!("_ferrite/static/{relative_path}"))
                    .unwrap(),
            );
        }
        let manifest = ProductionArtifactManifest::new(
            "/_ferrite/static",
            false,
            vec![ProductionArtifactRoute {
                path: "/".to_owned(),
                params: Vec::new(),
                server_module: "server/route.mjs".to_owned(),
                client_bundle: ClientBundle {
                    script: None,
                    action_bootstrap: None,
                    styles: Vec::new(),
                    outputs: Vec::new(),
                    sourcemaps: Vec::new(),
                    assets: Vec::new(),
                    client_references: Vec::new(),
                },
                prerendered: BTreeMap::new(),
                observed_actions: Vec::new(),
            }],
            files,
        )
        .unwrap();
        fs::write(
            artifact_root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let runner = project.join("artifact-runner.mjs");
        make_script(&runner, runner_body);
        let production = ProductionProject::from_artifact(ProductionServerConfig::from_artifact(
            project.to_path_buf(),
            artifact_root.clone(),
            runner,
        ))
        .unwrap();
        fs::remove_dir_all(artifact_root).unwrap();
        production
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

        let request = server_action_request_from_form(
            &same_origin,
            &action_form_body("/posts/abc"),
            None,
            None,
            None,
            None,
        )
        .expect("same-origin action request should parse");
        assert_eq!(request.route_path, "/posts/abc");

        let mut cross_origin = same_origin.clone();
        cross_origin.insert("origin".to_owned(), "https://evil.example".to_owned());
        let response = server_action_request_from_form(
            &cross_origin,
            &action_form_body("/posts/abc"),
            None,
            None,
            None,
            None,
        )
        .expect_err("cross-origin action request should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Origin"));

        let mut malformed_host = action_headers_with_host("application/x-www-form-urlencoded");
        malformed_host.insert("host".to_owned(), "local host".to_owned());
        malformed_host.insert("origin".to_owned(), "http://localhost".to_owned());
        let response = server_action_request_from_form(
            &malformed_host,
            &action_form_body("/posts/abc"),
            None,
            None,
            None,
            None,
        )
        .expect_err("malformed host should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Host"));

        let missing_host = action_headers("application/x-www-form-urlencoded");
        let response = server_action_request_from_form(
            &missing_host,
            &action_form_body("/posts/abc"),
            None,
            None,
            None,
            None,
        )
        .expect_err("missing host should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Host header is required"));
    }

    #[test]
    fn action_form_trusted_proxy_origin_uses_forwarded_public_origin() {
        let trusted_proxy = ProductionTrustedProxyConfig::new("https://app.example.com").unwrap();
        let mut headers = BTreeMap::from([
            (
                "content-type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
            ("host".to_owned(), "127.0.0.1:3000".to_owned()),
            ("x-forwarded-proto".to_owned(), "https".to_owned()),
            ("x-forwarded-host".to_owned(), "app.example.com".to_owned()),
            ("origin".to_owned(), "https://app.example.com".to_owned()),
            (
                "referer".to_owned(),
                "https://app.example.com/posts/abc".to_owned(),
            ),
        ]);

        let request = server_action_request_from_form(
            &headers,
            &action_form_body("/posts/abc"),
            None,
            None,
            Some(&trusted_proxy),
            None,
        )
        .expect("trusted proxy public origin should parse");
        assert_eq!(request.route_path, "/posts/abc");

        headers.insert("origin".to_owned(), "http://app.example.com".to_owned());
        let response = server_action_request_from_form(
            &headers,
            &action_form_body("/posts/abc"),
            None,
            None,
            Some(&trusted_proxy),
            None,
        )
        .expect_err("origin scheme mismatch should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("Origin"));
    }

    #[test]
    fn action_form_trusted_proxy_origin_requires_matching_forwarded_headers() {
        let trusted_proxy = ProductionTrustedProxyConfig::new("https://app.example.com").unwrap();
        let mut headers = BTreeMap::from([
            (
                "content-type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
            ("host".to_owned(), "127.0.0.1:3000".to_owned()),
            ("origin".to_owned(), "https://app.example.com".to_owned()),
        ]);

        let missing_forwarded = server_action_request_from_form(
            &headers,
            &action_form_body("/posts/abc"),
            None,
            None,
            Some(&trusted_proxy),
            None,
        )
        .expect_err("trusted proxy mode should require forwarded proto and host");
        assert_eq!(missing_forwarded.status, 403);
        assert!(missing_forwarded.body_text().contains("X-Forwarded-Proto"));

        headers.insert("x-forwarded-proto".to_owned(), "https".to_owned());
        headers.insert("x-forwarded-host".to_owned(), "evil.example".to_owned());
        let mismatched_host = server_action_request_from_form(
            &headers,
            &action_form_body("/posts/abc"),
            None,
            None,
            Some(&trusted_proxy),
            None,
        )
        .expect_err("trusted proxy mode should reject mismatched forwarded host");

        assert_eq!(mismatched_host.status, 403);
        assert!(mismatched_host.body_text().contains("X-Forwarded-Host"));
    }

    #[test]
    fn trusted_proxy_client_ip_policy_uses_configured_forwarded_hops() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut config = production_project_for(&app).config;
        let peer_ip = Some("127.0.0.1".parse::<IpAddr>().unwrap());
        let mut headers = BTreeMap::from([(
            "x-forwarded-for".to_owned(),
            "203.0.113.10, 198.51.100.5".to_owned(),
        )]);

        assert_eq!(
            production_client_ip(&headers, peer_ip, &config).as_deref(),
            Some("127.0.0.1")
        );

        config = config.with_trusted_proxy_client_ip_hops(1);
        assert_eq!(
            production_client_ip(&headers, peer_ip, &config).as_deref(),
            Some("198.51.100.5")
        );

        config = config.with_trusted_proxy_client_ip_hops(2);
        assert_eq!(
            production_client_ip(&headers, peer_ip, &config).as_deref(),
            Some("203.0.113.10")
        );

        headers.insert("x-forwarded-for".to_owned(), "203.0.113.10".to_owned());
        config = production_project_for(&app)
            .config
            .with_trusted_proxy_client_ip_hops(1);
        assert_eq!(
            production_client_ip(&headers, peer_ip, &config).as_deref(),
            Some("203.0.113.10")
        );

        headers.insert(
            "x-forwarded-for".to_owned(),
            "203.0.113.10, not-an-ip".to_owned(),
        );
        assert_eq!(
            production_client_ip(&headers, peer_ip, &config).as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn action_form_csrf_guard_requires_matching_configured_token() {
        let headers = action_headers_with_host("application/x-www-form-urlencoded");
        let body =
            b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route=%2Fposts%2Fabc&__ferrite_csrf=token-123&title=Hello";
        let request =
            server_action_request_from_form(&headers, body, Some("token-123"), None, None, None)
                .expect("matching CSRF token should parse");

        assert_eq!(request.route_path, "/posts/abc");
        assert!(!request.form.contains_key(SERVER_ACTION_CSRF_FIELD));
        assert_eq!(
            request.form.get("title"),
            Some(&ServerActionFormValue::String("Hello".to_owned()))
        );

        let missing = action_form_body("/posts/abc");
        let response = server_action_request_from_form(
            &headers,
            &missing,
            Some("token-123"),
            None,
            None,
            None,
        )
        .expect_err("missing CSRF token should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("CSRF token is required"));

        let wrong =
            b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route=%2Fposts%2Fabc&__ferrite_csrf=wrong";
        let response =
            server_action_request_from_form(&headers, wrong, Some("token-123"), None, None, None)
                .expect_err("wrong CSRF token should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("CSRF token is invalid"));

        let duplicate =
            b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route=%2Fposts%2Fabc&__ferrite_csrf=token-123&__ferrite_csrf=token-123";
        let response = server_action_request_from_form(
            &headers,
            duplicate,
            Some("token-123"),
            None,
            None,
            None,
        )
        .expect_err("duplicate CSRF token should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("CSRF token is required"));
    }

    #[test]
    fn action_form_csrf_cookie_guard_requires_matching_cookie() {
        let mut headers = action_headers_with_host("application/x-www-form-urlencoded");
        headers.insert(
            "cookie".to_owned(),
            "theme=dark; ferrite_action_csrf=token-123".to_owned(),
        );
        let body =
            b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&__ferrite_route=%2Fposts%2Fabc&__ferrite_csrf=token-123&title=Hello";
        let request = server_action_request_from_form(
            &headers,
            body,
            Some("token-123"),
            Some("ferrite_action_csrf"),
            None,
            None,
        )
        .expect("matching hidden token and cookie should parse");

        assert_eq!(request.route_path, "/posts/abc");
        assert!(!request.form.contains_key(SERVER_ACTION_CSRF_FIELD));

        headers.remove("cookie");
        let response = server_action_request_from_form(
            &headers,
            body,
            Some("token-123"),
            Some("ferrite_action_csrf"),
            None,
            None,
        )
        .expect_err("missing CSRF cookie should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("CSRF cookie is required"));

        headers.insert("cookie".to_owned(), "ferrite_action_csrf=wrong".to_owned());
        let response = server_action_request_from_form(
            &headers,
            body,
            Some("token-123"),
            Some("ferrite_action_csrf"),
            None,
            None,
        )
        .expect_err("mismatched CSRF cookie should be rejected");

        assert_eq!(response.status, 403);
        assert!(response.body_text().contains("CSRF cookie is invalid"));
    }

    #[test]
    fn action_form_replay_nonce_guard_consumes_once() {
        let headers = action_headers_with_host("application/x-www-form-urlencoded");
        let mut replay_nonces = ProductionReplayNonces::new(Duration::from_secs(30));
        let nonce = replay_nonces.issue().unwrap();
        let body = action_form_body_with_csrf_and_nonce("/posts/abc", "token-123", &nonce);

        let request = server_action_request_from_form(
            &headers,
            &body,
            Some("token-123"),
            None,
            None,
            Some(&mut replay_nonces),
        )
        .expect("fresh nonce should parse");

        assert_eq!(request.route_path, "/posts/abc");
        assert!(!request.form.contains_key(SERVER_ACTION_REPLAY_NONCE_FIELD));

        let replay = server_action_request_from_form(
            &headers,
            &body,
            Some("token-123"),
            None,
            None,
            Some(&mut replay_nonces),
        )
        .expect_err("used nonce should be rejected");

        assert_eq!(replay.status, 403);
        assert!(replay.body_text().contains("already used"));
    }

    #[test]
    fn action_form_replay_nonce_guard_rejects_missing_and_expired_nonces() {
        let headers = action_headers_with_host("application/x-www-form-urlencoded");
        let mut replay_nonces = ProductionReplayNonces::new(Duration::from_millis(1));

        let missing = server_action_request_from_form(
            &headers,
            &action_form_body_with_csrf("/posts/abc", "token-123"),
            Some("token-123"),
            None,
            None,
            Some(&mut replay_nonces),
        )
        .expect_err("missing nonce should be rejected");
        assert_eq!(missing.status, 403);
        assert!(missing.body_text().contains("replay nonce is required"));

        let nonce = replay_nonces.issue().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let expired = server_action_request_from_form(
            &headers,
            &action_form_body_with_csrf_and_nonce("/posts/abc", "token-123", &nonce),
            Some("token-123"),
            None,
            None,
            Some(&mut replay_nonces),
        )
        .expect_err("expired nonce should be rejected");

        assert_eq!(expired.status, 403);
        assert!(expired.body_text().contains("invalid or already used"));
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
                &action_headers_with_host("application/x-www-form-urlencoded"),
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
    fn dev_action_post_requires_configured_csrf_token() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_project_for(&app, action_renderer_body());
        project.config.server_action_csrf_token = Some("csrf-token-123".to_owned());

        let missing = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &action_form_body("/posts/abc"),
            )
            .unwrap();

        assert_eq!(missing.status, 403);
        assert!(missing.body_text().contains("CSRF token is required"));

        let response = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &action_form_body_with_csrf("/posts/abc", "csrf-token-123"),
            )
            .unwrap();
        let body: Value = serde_json::from_slice(&response.body).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["data"]["routePath"], "/posts/abc");
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
                &action_headers_with_host("application/x-www-form-urlencoded"),
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
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &action_form_body("/missing"),
            )
            .unwrap();
        assert_eq!(unknown.status, 404);
        assert!(unknown.body_text().contains("/missing"));

        let unsupported = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("text/plain"),
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
        assert!(events[0].client_ip.is_some());
    }

    #[test]
    fn production_action_observer_records_success_and_rejection_without_form_data() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let mut project = action_production_project_for(&app, action_renderer_body());
        project.config.action_observer = Some(ProductionActionObserver::new(move |event| {
            captured_events.lock().unwrap().push(event);
        }));
        let body = action_form_body("/posts/abc");
        let request = format!(
            "POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body).unwrap()
        );

        let response = production_http_request(project, request.as_bytes());
        assert!(response_headers(&response).starts_with("HTTP/1.1 200 OK"));

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].action_id.as_deref(),
            Some("app/posts/[id]/page.tsx#savePost")
        );
        assert_eq!(events[0].route_path.as_deref(), Some("/posts/abc"));
        assert_eq!(events[0].route_pattern.as_deref(), Some("/posts/:id"));
        assert_eq!(events[0].status, 200);
        assert_eq!(events[0].outcome, ProductionActionOutcome::Accepted);
        assert!(events[0].client_ip.is_some());
        assert!(events[0].elapsed > Duration::ZERO);
        assert_ne!(events[0].action_id.as_deref(), Some("Hello Ferrite"));
    }

    #[test]
    fn production_action_observer_records_parse_rejections() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let mut project = action_production_project_for(&app, action_renderer_body());
        project.config.action_observer = Some(ProductionActionObserver::new(move |event| {
            captured_events.lock().unwrap().push(event);
        }));
        let body = b"title=Hello+Ferrite";
        let request = format!(
            "POST /_ferrite/action HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body.to_vec()).unwrap()
        );

        let response = production_http_request(project, request.as_bytes());
        assert!(response_headers(&response).starts_with("HTTP/1.1 400 Bad Request"));

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action_id, None);
        assert_eq!(events[0].route_path, None);
        assert_eq!(events[0].route_pattern, None);
        assert_eq!(events[0].status, 400);
        assert_eq!(events[0].outcome, ProductionActionOutcome::Rejected);
        assert!(events[0].client_ip.is_some());
    }

    #[test]
    fn production_action_csrf_cookie_binding_sets_cookie_and_rejects_missing_cookie() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() { return <form></form>; }",
        );
        let mut project = action_production_project_for(
            &app,
            r##"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Post" }));
  process.exit(0);
}
if (mode === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", {}, [[2, "h1", {}, [[0, "Post"]]]]],
    chunks: []
  }));
  process.exit(0);
}
if (mode === "--server-action") {
  const request = JSON.parse(process.argv[7]);
  process.stdout.write(JSON.stringify({
    ferrite: "server-action-response",
    version: 1,
    status: "ok",
    data: { routePath: request.routePath }
  }));
  process.exit(0);
}
console.error(`unexpected renderer mode ${mode}`);
process.exit(1);
"##,
        );
        project.config.server_action_csrf_token = Some("token-123".to_owned());
        project.config.server_action_csrf_cookie_name = Some("ferrite_action_csrf".to_owned());

        let get_response =
            project.with_server_action_csrf_cookie(DevResponse::ok("text/html; charset=utf-8", ""));
        assert_eq!(
            get_response.set_cookie_headers,
            vec![
                "ferrite_action_csrf=token-123; Path=/; SameSite=Lax; HttpOnly; Secure".to_owned()
            ]
        );

        let body = action_form_body_with_csrf("/posts/abc", "token-123");
        let missing_cookie = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &body,
            )
            .unwrap();

        assert_eq!(missing_cookie.status, 403);
        assert!(
            missing_cookie
                .body_text()
                .contains("CSRF cookie is required")
        );

        let mut headers = action_headers_with_host("application/x-www-form-urlencoded");
        headers.insert(
            "cookie".to_owned(),
            "ferrite_action_csrf=token-123".to_owned(),
        );
        let accepted = project
            .handle_post("/_ferrite/action", &headers, &body)
            .unwrap();
        let accepted_body: Value = serde_json::from_slice(&accepted.body).unwrap();

        assert_eq!(accepted.status, 200);
        assert_eq!(accepted_body["status"], "ok");
        assert_eq!(accepted_body["data"]["routePath"], "/posts/abc");
    }

    #[test]
    fn production_action_replay_guard_rejects_reused_nonce() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let config = action_production_project_for(&app, action_renderer_body())
            .config
            .with_server_action_csrf_token("token-123")
            .with_server_action_replay_ttl(Duration::from_secs(30));
        let project = ProductionProject::new(config);
        let nonce = project
            .replay_nonces
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .issue()
            .unwrap();
        let body = action_form_body_with_csrf_and_nonce("/posts/abc", "token-123", &nonce);
        let headers = action_headers_with_host("application/x-www-form-urlencoded");

        let accepted = project
            .handle_post("/_ferrite/action", &headers, &body)
            .unwrap();
        let accepted_body: Value = serde_json::from_slice(&accepted.body).unwrap();
        assert_eq!(accepted.status, 200);
        assert_eq!(accepted_body["status"], "ok");
        assert_eq!(accepted_body["data"]["routePath"], "/posts/abc");

        let replayed = project
            .handle_post("/_ferrite/action", &headers, &body)
            .unwrap();
        assert_eq!(replayed.status, 403);
        assert!(replayed.body_text().contains("already used"));
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
    fn production_action_post_accepts_trusted_proxy_public_origin_on_real_socket() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let mut project = action_production_project_for(&app, action_renderer_body());
        project.config.trusted_proxy =
            Some(ProductionTrustedProxyConfig::new("https://app.example.com").unwrap());
        let body = action_form_body("/posts/abc");
        let request = format!(
            "POST /_ferrite/action HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: app.example.com\r\nOrigin: https://app.example.com\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8(body).unwrap()
        );

        let response = production_http_request(project, request.as_bytes());
        let headers = response_headers(&response);
        let body: Value = serde_json::from_slice(response_body(&response)).unwrap();

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(body["status"], "ok");
        assert_eq!(body["data"]["routePath"], "/posts/abc");
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
            project.config.response_write_timeout,
            DEFAULT_PRODUCTION_RESPONSE_WRITE_TIMEOUT
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
                .with_response_write_timeout(Duration::ZERO)
                .with_render_timeout(Duration::ZERO)
                .with_max_request_bytes(0)
                .with_max_in_flight_requests(0),
        );

        assert_eq!(
            project.config.request_read_timeout,
            MIN_PRODUCTION_REQUEST_READ_TIMEOUT
        );
        assert_eq!(
            project.config.response_write_timeout,
            MIN_PRODUCTION_RESPONSE_WRITE_TIMEOUT
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
        let project =
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
    fn production_metrics_endpoint_records_route_responses() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let project = ProductionProject::new(
            production_project_for(&app)
                .config
                .with_metrics_path("/__ferrite/metrics"),
        );

        let page = project.handle_get("/posts/abc").unwrap();
        let missing = project.handle_get("/missing").unwrap();
        let metrics = project.handle_get("/__ferrite/metrics").unwrap();

        assert_eq!(page.status, 200);
        assert_eq!(missing.status, 404);
        assert_eq!(metrics.status, 200);
        assert_eq!(
            metrics.content_type,
            "text/plain; version=0.0.4; charset=utf-8"
        );
        assert_eq!(metrics.cache_control, Some("no-store"));
        let body = metrics.body_text();
        assert!(body.contains("# TYPE ferrite_production_requests_total counter"));
        assert!(body.contains(
            r#"ferrite_production_requests_total{method="GET",status="200",route="/posts/:id"} 1"#
        ));
        assert!(body.contains(
            r#"ferrite_production_requests_total{method="GET",status="404",route="-"} 1"#
        ));
    }

    #[test]
    fn production_metrics_endpoint_records_action_outcomes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Page() {}",
        );
        let project = ProductionProject::new(
            action_production_project_for(&app, action_renderer_body())
                .config
                .with_metrics_path("/__ferrite/metrics"),
        );

        let success = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &action_form_body("/posts/abc"),
            )
            .unwrap();
        let rejected = project
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                b"__ferrite_action=app%2Fposts%2F%5Bid%5D%2Fpage.tsx%23savePost&title=Hello",
            )
            .unwrap();
        let metrics = project.handle_get("/__ferrite/metrics").unwrap();

        assert_eq!(success.status, 200);
        assert_eq!(rejected.status, 400);
        let body = metrics.body_text();
        assert!(body.contains("# TYPE ferrite_production_actions_total counter"));
        assert!(body.contains(
            r#"ferrite_production_actions_total{outcome="accepted",status="200",route="/posts/:id"} 1"#
        ));
        assert!(body.contains(
            r#"ferrite_production_actions_total{outcome="rejected",status="400",route="-"} 1"#
        ));
        assert!(!body.contains("savePost"));
        assert!(!body.contains("Hello"));
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
        let project = ProductionProject::new(
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
        assert!(!body.contains("page renderer timed out"));
        assert!(body.contains(r#"id="ferrite-root""#));
    }

    #[test]
    fn production_worker_pool_clamps_empty_worker_count() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(production_project_for(&app));

        let pool = ProductionWorkerPool::new(0, project);

        assert_eq!(pool.worker_count(), 1);
        assert_eq!(pool.overload_worker_count(), 1);
        pool.shutdown();
    }

    #[test]
    fn production_worker_pool_bounds_overload_rejection_workers() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(production_project_for(&app));

        let pool = ProductionWorkerPool::new(8, project);

        assert_eq!(pool.worker_count(), 8);
        assert_eq!(
            pool.overload_worker_count(),
            MAX_PRODUCTION_OVERLOAD_WORKERS
        );
        pool.shutdown();
    }

    #[test]
    fn production_worker_pool_rejects_connections_over_the_configured_limit() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(production_project_for(&app));
        let pool = ProductionWorkerPool::new(1, project);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let mut first_client = TcpStream::connect(addr).unwrap();
        let (first_server, _) = listener.accept().unwrap();
        first_client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n")
            .unwrap();
        pool.send(first_server).unwrap();
        assert_eq!(pool.in_flight_count(), 1);

        let mut overloaded_client = TcpStream::connect(addr).unwrap();
        let (overloaded_server, _) = listener.accept().unwrap();
        pool.send(overloaded_server).unwrap();
        let mut response = String::new();
        overloaded_client.read_to_string(&mut response).unwrap();

        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(response.contains("Cache-Control: no-store"));
        assert_eq!(pool.in_flight_count(), 1);

        drop(first_client);
        pool.shutdown();
    }

    #[test]
    fn production_worker_pool_delivers_overload_response_when_request_bytes_arrive_after_accept() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(production_project_for(&app));
        let pool = Arc::new(ProductionWorkerPool::new(1, project));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let first_client = TcpStream::connect(addr).unwrap();
        let (first_server, _) = listener.accept().unwrap();
        pool.send(first_server).unwrap();
        assert_eq!(pool.in_flight_count(), 1);

        let mut overloaded_client = TcpStream::connect(addr).unwrap();
        overloaded_client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (overloaded_server, _) = listener.accept().unwrap();
        pool.send(overloaded_server).unwrap();
        overloaded_client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        overloaded_client.shutdown(Shutdown::Write).unwrap();
        let response =
            String::from_utf8(read_http_response(&mut overloaded_client).unwrap()).unwrap();

        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(!response.contains("408 Request Timeout"));
        assert_eq!(pool.in_flight_count(), 1);

        drop(first_client);
        Arc::try_unwrap(pool).unwrap().shutdown();
    }

    #[test]
    fn production_worker_pool_keeps_admission_bounded_during_silent_overload() {
        const SILENT_OVERLOAD_CLIENTS: usize = 32;

        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = Arc::new(production_project_for(&app));
        let pool = ProductionWorkerPool::new(1, project);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let first_client = TcpStream::connect(addr).unwrap();
        let (first_server, _) = listener.accept().unwrap();
        pool.send(first_server).unwrap();
        assert_eq!(pool.in_flight_count(), 1);

        let admission_started = Instant::now();
        let mut silent_clients = Vec::new();
        for _ in 0..SILENT_OVERLOAD_CLIENTS {
            let client = TcpStream::connect(addr).unwrap();
            let (server, _) = listener.accept().unwrap();
            pool.send(server).unwrap();
            silent_clients.push(client);
        }
        assert!(admission_started.elapsed() < Duration::from_millis(500));

        let mut complete_client = TcpStream::connect(addr).unwrap();
        complete_client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        complete_client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        complete_client.shutdown(Shutdown::Write).unwrap();
        let (complete_server, _) = listener.accept().unwrap();
        let rejection_started = Instant::now();
        pool.send(complete_server).unwrap();
        let response =
            String::from_utf8(read_http_response(&mut complete_client).unwrap()).unwrap();

        assert!(rejection_started.elapsed() < Duration::from_secs(1));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(!response.contains("408 Request Timeout"));

        drop(silent_clients);
        drop(first_client);
        pool.shutdown();
    }

    #[test]
    fn overload_request_drain_uses_an_absolute_budget_for_trickle_input() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            for _ in 0..100 {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();

        let started = Instant::now();
        drain_overload_request(&mut stream, Duration::from_millis(25), 1024).unwrap();
        let elapsed = started.elapsed();
        drop(stream);
        client.join().unwrap();

        assert!(elapsed >= Duration::from_millis(20));
        assert!(elapsed < Duration::from_millis(100));
    }

    #[test]
    fn artifact_worker_pool_recovers_after_a_saturation_wave() {
        let temp = tempfile::tempdir().unwrap();
        let mut project = artifact_production_project_with_runner(
            temp.path(),
            r#"
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.shift() !== "--prebuilt-stdin") process.exit(2);
const mode = args[0];
if (mode === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (mode !== "--stream") process.exit(3);
const started = new URL("./overload-started/", import.meta.url);
const release = new URL("./overload-release", import.meta.url);
mkdirSync(started, { recursive: true });
writeFileSync(new URL(String(process.pid), started), "started");
const deadline = Date.now() + 15000;
while (!existsSync(release)) {
  if (Date.now() >= deadline) throw new Error("overload test release never arrived");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [2, "main", {}, [[0, "overload recovered"]]],
  chunks: []
}));
"#,
        );
        project.config.max_in_flight_requests = 2;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();
        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let mut held_clients = Vec::new();
        for _ in 0..2 {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
            held_clients.push(stream);
        }
        wait_for_directory_entries(&temp.path().join("overload-started"), 2);

        let overload_started = Instant::now();
        let overloaded = (0..6)
            .map(|_| {
                request_to_addr_with_timeout(
                    addr,
                    b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
                    Duration::from_secs(1),
                )
            })
            .collect::<Vec<_>>();
        assert!(overload_started.elapsed() < Duration::from_secs(2));
        assert!(
            overloaded
                .iter()
                .all(|response| response.starts_with("HTTP/1.1 503 Service Unavailable"))
        );
        assert!(
            overloaded
                .iter()
                .all(|response| response.contains("Cache-Control: no-store"))
        );

        write(&temp.path().join("overload-release"), "release");
        for mut stream in held_clients {
            let response = String::from_utf8(read_http_response(&mut stream).unwrap()).unwrap();
            assert!(response.starts_with("HTTP/1.1 200 OK"));
            assert!(response.contains("overload recovered"));
        }
        let recovered = request_to_addr_with_timeout(
            addr,
            b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
            Duration::from_secs(5),
        );
        controller.shutdown();
        server.join().unwrap();

        assert!(recovered.starts_with("HTTP/1.1 200 OK"));
        assert!(recovered.contains("overload recovered"));
    }

    #[test]
    fn artifact_worker_recovers_after_runner_process_failure() {
        let temp = tempfile::tempdir().unwrap();
        let mut project = artifact_production_project_with_runner(
            temp.path(),
            r#"
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.shift() !== "--prebuilt-stdin") process.exit(2);
const mode = args[0];
if (mode === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (mode !== "--stream") process.exit(3);
const failed = new URL("./runner-failed-once", import.meta.url);
if (!existsSync(failed)) {
  writeFileSync(failed, "failed");
  console.error("synthetic artifact runner failure");
  process.exit(17);
}
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [2, "main", {}, [[0, "runner recovered"]]],
  chunks: []
}));
"#,
        );
        project.config.max_in_flight_requests = 1;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();
        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let failed = request_to_addr_with_timeout(
            addr,
            b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
            Duration::from_secs(5),
        );
        let recovered = request_to_addr_with_timeout(
            addr,
            b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
            Duration::from_secs(5),
        );
        controller.shutdown();
        server.join().unwrap();

        assert!(
            failed.starts_with("HTTP/1.1 500 Internal Server Error"),
            "unexpected failed-runner response: {failed:?}"
        );
        assert!(failed.contains("Ferrite could not render this route."));
        assert!(!failed.contains("synthetic artifact runner failure"));
        assert!(
            recovered.starts_with("HTTP/1.1 200 OK"),
            "unexpected recovery response: {recovered:?}"
        );
        assert!(recovered.contains("runner recovered"));
        assert!(temp.path().join("runner-failed-once").exists());
    }

    #[test]
    fn artifact_server_sustains_mixed_load_and_recovers_without_resource_growth() {
        const WORKERS: usize = 4;
        const SLOW_READER_WAVES: usize = 3;
        const OVERLOAD_CLIENTS: usize = 8;
        const LOAD_WAVES: usize = 10;
        const LOAD_CLIENTS: usize = 8;
        const SLOW_ASSET_BYTES: usize = 64 * 1024 * 1024;
        const RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_millis(100);
        const REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
        const SLOW_REQUEST: &[u8] =
            b"GET /_ferrite/static/slow.bin HTTP/1.1\r\nHost: localhost\r\n\r\n";

        let temp = tempfile::tempdir().unwrap();
        let asset = vec![b'x'; SLOW_ASSET_BYTES];
        let mut project = artifact_production_project_with_runner_and_asset(
            temp.path(),
            r#"
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
const args = process.argv.slice(2);
if (args.shift() !== "--prebuilt-stdin") process.exit(2);
const mode = args[0];
const lifecycle = new URL("./runner-lifecycle.log", import.meta.url);
const record = (event) => appendFileSync(lifecycle, `${event}\n`);
record(`started:${mode}`);
if (mode === "--metadata") {
  process.stdout.write("{}");
  record(`completed:${mode}`);
  process.exit(0);
}
if (mode !== "--stream") process.exit(3);
await new Promise((resolve) => setTimeout(resolve, 8));
const failNext = new URL("./fail-next-runner", import.meta.url);
if (existsSync(failNext)) {
  unlinkSync(failNext);
  record(`failed:${mode}`);
  console.error("synthetic soak runner failure");
  process.exit(17);
}
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [2, "main", {}, [[0, "soak recovered"]]],
  chunks: []
}));
record(`completed:${mode}`);
"#,
            Some(("slow.bin", &asset)),
        );
        project.config.max_in_flight_requests = WORKERS;
        project.config.request_read_timeout = Duration::from_millis(500);
        project.config.response_write_timeout = RESPONSE_WRITE_TIMEOUT;
        project.config.render_timeout = Duration::from_secs(2);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();
        let soak_started = Instant::now();
        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let warmup = request_to_addr_with_timeout(addr, REQUEST, Duration::from_secs(3));
        assert_eq!(response_status(&warmup), 200, "warmup failed: {warmup:?}");

        let mut overload_responses = 0;
        for wave in 0..SLOW_READER_WAVES {
            let slow_readers = (0..WORKERS)
                .map(|_| {
                    thread::spawn(move || {
                        connect_admitted_slow_reader(addr, SLOW_REQUEST, Duration::from_secs(2))
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|client| client.join().unwrap())
                .collect::<Vec<_>>();
            let all_slow_readers_admitted = Instant::now();

            let overload_started = Instant::now();
            let overloaded = concurrent_requests_to_addr(
                addr,
                REQUEST,
                OVERLOAD_CLIENTS,
                Duration::from_secs(2),
            );
            assert!(
                overload_started.elapsed() < Duration::from_secs(2),
                "overload responses exceeded their bound in wave {wave}"
            );
            for response in overloaded {
                assert_eq!(
                    response_status(&response),
                    503,
                    "complete overload request returned an unexpected status in wave {wave}: {response:?}"
                );
                assert!(response.contains("Cache-Control: no-store"));
                overload_responses += 1;
            }

            let recovery_deadline = Instant::now() + Duration::from_secs(3);
            let recovered = loop {
                let response = request_to_addr_with_timeout(addr, REQUEST, Duration::from_secs(2));
                let status = response_status(&response);
                assert_ne!(
                    status, 408,
                    "complete request received a false 408 in wave {wave}"
                );
                if status == 200 {
                    break response;
                }
                assert_eq!(status, 503, "unexpected recovery status in wave {wave}");
                assert!(
                    Instant::now() < recovery_deadline,
                    "workers did not recover in wave {wave}"
                );
                thread::sleep(Duration::from_millis(10));
            };
            assert!(recovered.contains("soak recovered"));

            let settled_deadline =
                all_slow_readers_admitted + RESPONSE_WRITE_TIMEOUT + Duration::from_millis(50);
            if Instant::now() < settled_deadline {
                thread::sleep(settled_deadline - Instant::now());
            }

            for mut stream in slow_readers {
                let mut response = Vec::new();
                if let Err(error) = stream.read_to_end(&mut response) {
                    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
                }
                assert!(response.starts_with(b"HTTP/1.1 200 OK"));
                assert!(
                    response_body(&response).len() < SLOW_ASSET_BYTES,
                    "slow reader unexpectedly received the entire asset in wave {wave}"
                );
            }
        }
        assert_eq!(overload_responses, SLOW_READER_WAVES * OVERLOAD_CLIENTS);

        write(&temp.path().join("fail-next-runner"), "fail");
        let failed = request_to_addr_with_timeout(addr, REQUEST, Duration::from_secs(3));
        assert_eq!(
            response_status(&failed),
            500,
            "post-saturation runner failure was not isolated"
        );
        assert!(!failed.contains("synthetic soak runner failure"));
        let recovered = request_to_addr_with_timeout(addr, REQUEST, Duration::from_secs(3));
        assert_eq!(
            response_status(&recovered),
            200,
            "runner did not recover after saturation"
        );

        let mut successful_load_responses = 0;
        let mut admitted_overload_responses = 0;
        for wave in 0..LOAD_WAVES {
            let responses =
                concurrent_requests_to_addr(addr, REQUEST, LOAD_CLIENTS, Duration::from_secs(3));
            let mut wave_successes = 0;
            for response in responses {
                match response_status(&response) {
                    200 => {
                        assert!(response.contains("soak recovered"));
                        successful_load_responses += 1;
                        wave_successes += 1;
                    }
                    503 => {
                        assert!(response.contains("Cache-Control: no-store"));
                        admitted_overload_responses += 1;
                    }
                    408 => panic!("complete load request received a false 408 in wave {wave}"),
                    status => panic!("unexpected load status {status} in wave {wave}"),
                }
            }
            assert!(wave_successes > 0, "load wave {wave} admitted no requests");
        }
        assert!(successful_load_responses >= LOAD_WAVES);
        assert!(admitted_overload_responses > 0);

        for request_index in 0..WORKERS * 2 {
            let response = request_to_addr_with_timeout(addr, REQUEST, Duration::from_secs(3));
            assert_eq!(
                response_status(&response),
                200,
                "post-soak request {request_index} did not recover"
            );
        }

        controller.shutdown();
        let shutdown_started = Instant::now();
        server.join().unwrap();
        assert!(shutdown_started.elapsed() < Duration::from_secs(5));
        assert!(soak_started.elapsed() < Duration::from_secs(30));

        let lifecycle = fs::read_to_string(temp.path().join("runner-lifecycle.log")).unwrap();
        let started = lifecycle
            .lines()
            .filter(|line| line.starts_with("started:"))
            .count();
        let completed = lifecycle
            .lines()
            .filter(|line| line.starts_with("completed:"))
            .count();
        let failed = lifecycle
            .lines()
            .filter(|line| line.starts_with("failed:"))
            .count();
        assert_eq!(failed, 1);
        assert_eq!(started, completed + failed);
        assert!(completed >= successful_load_responses * 2);
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
    fn production_shutdown_bounds_a_stalled_response_writer() {
        const ASSET_BYTES: usize = 64 * 1024 * 1024;

        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = production_project_for(&app);
        project.config.response_write_timeout = Duration::from_millis(50);
        project.config.max_in_flight_requests = 1;
        project
            .snapshot
            .set(ProductionRouteSnapshot {
                routes: Vec::new(),
                document_file: None,
                client_bundles: BTreeMap::new(),
                server_module_sources: BTreeMap::new(),
                verified_static_assets: Some(BTreeMap::from([(
                    "large.bin".to_owned(),
                    Arc::<[u8]>::from(vec![b'x'; ASSET_BYTES]),
                )])),
            })
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (controller, signal) = ProductionShutdownController::new_pair();
        let server = thread::spawn(move || {
            serve_production_listener_with_shutdown(listener, project, signal).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(b"GET /_ferrite/static/large.bin HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut first_byte = [0_u8; 1];
        assert_eq!(stream.peek(&mut first_byte).unwrap(), 1);

        let started = Instant::now();
        controller.shutdown();
        server.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));

        let mut response = Vec::new();
        if let Err(error) = stream.read_to_end(&mut response) {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        }
        assert!(response.starts_with(b"HTTP/1.1 200 OK"));
        assert!(response_body(&response).len() < ASSET_BYTES);
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
            serve_production_listener_once(listener, &project).unwrap();
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
    fn response_deadline_writer_uses_one_budget_across_writes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut writer = ResponseDeadlineWriter::new(&mut stream, Duration::from_millis(25));
            writer.write_all(b"first").unwrap();
            thread::sleep(Duration::from_millis(50));
            writer
                .write_all(b"second")
                .expect_err("the deadline must not reset after a successful write")
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        let error = server.join().unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(
            error.to_string(),
            PRODUCTION_RESPONSE_WRITE_DEADLINE_MESSAGE
        );
        assert_eq!(response, b"first");
    }

    #[test]
    fn production_adapter_times_out_a_stalled_response_reader() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handle_production_stream_with_limits(
                &mut stream,
                Duration::from_secs(1),
                Duration::from_millis(50),
                DEFAULT_PRODUCTION_MAX_REQUEST_BYTES,
                |_request| {
                    Ok(DevResponse::ok(
                        "application/octet-stream",
                        vec![b'x'; 64 * 1024 * 1024],
                    ))
                },
            )
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let started = Instant::now();
        let error = server
            .join()
            .unwrap()
            .expect_err("a stalled reader must exhaust the response deadline");

        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(matches!(
            error,
            DevServerError::Io(ref error)
                if error.kind() == std::io::ErrorKind::TimedOut
                    && error.to_string().contains("response write deadline exceeded")
        ));
        drop(stream);
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
        let project = production_project_for(&app);

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
        let project = production_project_for(&app);

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
        let project = production_project_for(&app);

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
        let project = production_project_for(&app);
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
        let project = production_project_for(&app);

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
            let project = project;
            serve_production_listener_once(listener, &project).unwrap();
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
        let project = ProductionProject::new(ProductionServerConfig::new(
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
        assert!(!body.contains("render exploded"));
        assert!(body.contains(r#"id="ferrite-root""#));
        assert!(!body.contains("data-ferrite-build-id"));
    }

    #[test]
    fn production_client_bundle_timeout_returns_generic_gateway_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (mode === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", routePattern: "/", actions: [] }));
  process.exit(0);
}
if (mode === "--stream") {
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
        make_script(&bundler, "setInterval(() => {}, 1000); // bundler-secret");
        let project = ProductionProject::new(
            ProductionServerConfig::new(
                project.clone(),
                app,
                project.join(".ferrite/types/routes.d.ts"),
                renderer,
                bundler,
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
        assert!(!body.contains("bundler-secret"));
        assert!(!body.contains("client bundler timed out"));
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

    #[test]
    fn artifact_production_serves_dynamic_routes_payloads_actions_and_assets_without_source() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .to_path_buf();
        let temp = tempfile::tempdir_in(workspace.join("examples/basic")).unwrap();
        let project = temp.path();
        write(
            &project.join("package.json"),
            r#"{"private":true,"type":"module"}"#,
        );
        write(
            &project.join("node_modules/artifact-value/package.json"),
            r#"{"name":"artifact-value","type":"module","exports":"./index.js"}"#,
        );
        write(
            &project.join("node_modules/artifact-value/index.js"),
            r#"export const artifactValue = "bundled dependency";"#,
        );
        write(
            &project.join("app/posts/[id]/Client.tsx"),
            r#"
"use client";
import { useState } from "@ferrite/runtime";
export default function Client({ id }) {
  const [count] = useState(0);
  return <span data-client={id}>{count}</span>;
}
"#,
        );
        write(
            &project.join("app/posts/[id]/page.tsx"),
            r#"
import { createServerAction } from "@ferrite/runtime/server";
import { artifactValue } from "artifact-value";
import Client from "./Client";
export function generateMetadata({ params }) {
  return { title: `Artifact ${params.id}` };
}
export default function Page({ params }) {
  const actionId = params.id === "conditional"
    ? "app/posts/[id]/page.tsx#conditional"
    : "app/posts/[id]/page.tsx#savePost";
  const savePost = createServerAction({
    id: actionId,
    routePattern: "/posts/:id",
    run({ routePath, form }) {
      return { routePath, title: form.title || "" };
    }
  });
  return <main><h1>Artifact {params.id} {artifactValue}</h1><form action={savePost}><input name="title" /></form><Client id={params.id} /></main>;
}
"#,
        );
        let renderer = workspace.join("packages/runtime/bin/render-page.mjs");
        let artifact_runner = workspace.join("packages/runtime/bin/render-artifact.mjs");
        let bundler = workspace.join("packages/runtime/bin/build-client.mjs");
        let artifact_root = project.join(".ferrite/build");
        let report = build_project(&BuildConfig::new(
            project.to_path_buf(),
            project.join("app"),
            artifact_root.clone(),
            project.join(".ferrite/types/routes.d.ts"),
            renderer.clone(),
            bundler,
        ))
        .unwrap();
        assert_eq!(report.skipped_dynamic_routes, vec!["/posts/:id"]);
        assert!(report.html_files.is_empty());
        write(
            &artifact_root.join("_ferrite/static/undeclared.js"),
            "console.log('not in manifest');",
        );

        fs::remove_dir_all(project.join("app")).unwrap();
        fs::remove_dir_all(project.join("node_modules")).unwrap();
        let temp_runtime_dir = project.join(".ferrite/tmp");
        if temp_runtime_dir.exists() {
            fs::remove_dir_all(&temp_runtime_dir).unwrap();
        }
        let production = ProductionProject::from_artifact(ProductionServerConfig::from_artifact(
            project.to_path_buf(),
            artifact_root.clone(),
            artifact_runner,
        ))
        .unwrap();
        fs::remove_dir_all(&artifact_root).unwrap();

        let html = production.handle_get("/posts/live").unwrap();
        let html_body = html.body_text();
        assert_eq!(html.status, 200);
        assert!(html_body.contains("<title>Artifact live</title>"));
        assert!(html_body.contains("<h1>Artifact live bundled dependency</h1>"));
        assert!(html_body.contains("data-ferrite-page-props"));
        assert!(html_body.contains("app/posts/[id]/page.tsx#savePost"));
        assert!(!temp_runtime_dir.exists());

        let payload = production
            .handle_get("/posts/live?__ferrite_payload=server")
            .unwrap();
        let packet: ServerPayloadPacket = serde_json::from_slice(&payload.body).unwrap();
        ferrite_protocol::validate_server_payload_packet(&packet).unwrap();

        let action = production
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                &action_form_body("/posts/live"),
            )
            .unwrap();
        let action_body: Value = serde_json::from_slice(&action.body).unwrap();
        assert_eq!(action.status, 200);
        assert_eq!(action_body["data"]["routePath"], "/posts/live");

        let conditional_action = String::from_utf8(action_form_body("/posts/conditional"))
            .unwrap()
            .replace("%23savePost", "%23conditional");
        let conditional = production
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                conditional_action.as_bytes(),
            )
            .unwrap();
        let conditional_body: Value = serde_json::from_slice(&conditional.body).unwrap();
        assert_eq!(conditional.status, 200);
        assert_eq!(conditional_body["data"]["routePath"], "/posts/conditional");

        let unknown_action = String::from_utf8(action_form_body("/posts/live"))
            .unwrap()
            .replace("%23savePost", "%23missing");
        let rejected = production
            .handle_post(
                "/_ferrite/action",
                &action_headers_with_host("application/x-www-form-urlencoded"),
                unknown_action.as_bytes(),
            )
            .unwrap();
        assert_eq!(rejected.status, 404);

        let script = static_script_src(&html_body);
        let asset = production.handle_get(&script).unwrap();
        assert_eq!(asset.status, 200);
        assert_eq!(
            asset.cache_control,
            Some("public, max-age=31536000, immutable")
        );
        let undeclared_asset = production
            .handle_get("/_ferrite/static/undeclared.js")
            .unwrap();
        assert_eq!(undeclared_asset.status, 404);
    }

    #[test]
    fn artifact_production_requests_execute_in_parallel_without_a_project_lock() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_root = temp.path().join("artifact");
        write(
            &artifact_root.join("server/route.mjs"),
            "export const routePattern = '/';\n",
        );
        let server_file = artifact_file_record(&artifact_root, "server/route.mjs").unwrap();
        let manifest = ProductionArtifactManifest::new(
            "/_ferrite/static",
            false,
            vec![ProductionArtifactRoute {
                path: "/".to_owned(),
                params: Vec::new(),
                server_module: "server/route.mjs".to_owned(),
                client_bundle: ClientBundle {
                    script: None,
                    action_bootstrap: None,
                    styles: Vec::new(),
                    outputs: Vec::new(),
                    sourcemaps: Vec::new(),
                    assets: Vec::new(),
                    client_references: Vec::new(),
                },
                prerendered: BTreeMap::new(),
                observed_actions: Vec::new(),
            }],
            vec![server_file],
        )
        .unwrap();
        fs::write(
            artifact_root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let runner = temp.path().join("artifact-runner.mjs");
        make_script(
            &runner,
            r#"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.shift() !== "--prebuilt-stdin") process.exit(2);
const mode = args[0];
if (mode === "--metadata") {
  const barrier = new URL("./runner-barrier", import.meta.url);
  mkdirSync(barrier, { recursive: true });
  writeFileSync(new URL(`./runner-barrier/${process.pid}`, import.meta.url), "started");
  const deadline = Date.now() + 15000;
  while (readdirSync(barrier).length < 2) {
    if (Date.now() >= deadline) throw new Error("concurrent artifact runner never reached barrier");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  process.stdout.write("{}");
} else {
  process.stdout.write(JSON.stringify({ ferrite: "render-stream", version: 1, shell: [0, "parallel"], chunks: [] }));
}
"#,
        );
        let project = Arc::new(
            ProductionProject::from_artifact(ProductionServerConfig::from_artifact(
                temp.path().to_path_buf(),
                artifact_root,
                runner,
            ))
            .unwrap(),
        );
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let project = Arc::clone(&project);
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                project.handle_get("/").unwrap()
            }));
        }

        barrier.wait();
        let responses = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert!(responses.iter().all(|response| response.status == 200));
        assert!(
            responses
                .iter()
                .all(|response| response.body_text().contains("parallel"))
        );
        assert_eq!(
            fs::read_dir(temp.path().join("runner-barrier"))
                .unwrap()
                .count(),
            2
        );
    }
}
