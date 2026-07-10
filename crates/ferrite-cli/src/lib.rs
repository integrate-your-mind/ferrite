use std::env;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};
use ferrite_builder::{BuildConfig, BuildReport};
use ferrite_dev_server::{
    DevProject, DevResponse, DevServerConfig, ProductionActionEvent, ProductionActionOutcome,
    ProductionProject, ProductionRequestEvent, ProductionServerConfig,
    ProductionTrustedProxyConfig,
};
use ferrite_router::{Route, scan_app_dir, write_route_types};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(name = "ferrite")]
#[command(about = "Rust-first React/Next-style framework tooling")]
#[command(version)]
pub struct Cli {
    #[arg(long, global = true, help = "Print machine-readable JSON output")]
    json: bool,

    #[arg(long, global = true, help = "Print stable plain text output")]
    plain: bool,

    #[arg(long, global = true, help = "Disable colored output")]
    no_color: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(about = "List file-system routes discovered under app/")]
    Routes(ProjectArgs),

    #[command(about = "Generate route types and run TypeScript checks")]
    Check(CheckArgs),

    #[command(about = "Render a serialized Ferrite VNode tree to HTML")]
    Render(RenderArgs),

    #[command(about = "Run the Ferrite development server")]
    Dev(DevArgs),

    #[command(about = "Run the Ferrite production HTTP adapter")]
    Serve(Box<ServeArgs>),

    #[command(about = "Build static Ferrite production output")]
    Build(BuildArgs),
}

#[derive(Debug, Args)]
struct ProjectArgs {
    #[arg(
        long,
        default_value = ".",
        help = "Project root containing the app directory"
    )]
    project: PathBuf,

    #[arg(
        long,
        default_value = "app",
        help = "App directory, relative to --project unless absolute"
    )]
    app: PathBuf,

    #[arg(long, help = "Write generated Ferrite route types to this path")]
    types_out: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct CheckArgs {
    #[arg(
        long,
        default_value = ".",
        help = "Project root containing tsconfig.json"
    )]
    project: PathBuf,

    #[arg(
        long,
        default_value = "app",
        help = "App directory, relative to --project unless absolute"
    )]
    app: PathBuf,

    #[arg(
        long,
        default_value = ".ferrite/types/routes.d.ts",
        help = "Generated route types path, relative to --project unless absolute"
    )]
    types_out: PathBuf,

    #[arg(long, help = "Skip the TypeScript compiler step")]
    skip_typescript: bool,
}

#[derive(Debug, Args)]
struct RenderArgs {
    #[arg(
        long,
        default_value = "-",
        help = "JSON input file containing a serialized VNode tree, or - for stdin"
    )]
    input: PathBuf,
}

#[derive(Debug, Args)]
struct DevArgs {
    #[arg(
        long,
        default_value = ".",
        help = "Project root containing tsconfig.json"
    )]
    project: PathBuf,

    #[arg(
        long,
        default_value = "app",
        help = "App directory, relative to --project unless absolute"
    )]
    app: PathBuf,

    #[arg(
        long,
        default_value = ".ferrite/types/routes.d.ts",
        help = "Generated route types path, relative to --project unless absolute"
    )]
    types_out: PathBuf,

    #[arg(long, default_value = "127.0.0.1", help = "Host address to bind")]
    host: String,

    #[arg(long, default_value_t = 3000, help = "Port to bind")]
    port: u16,

    #[arg(
        long,
        help = "Serve one synthetic GET request and exit, useful for checks"
    )]
    once: bool,

    #[arg(long, default_value = "/", help = "Request path used with --once")]
    request_path: String,

    #[arg(
        long,
        default_value = "packages/runtime/bin/render-page.mjs",
        help = "Page renderer script path, relative to the current directory unless absolute"
    )]
    page_renderer: PathBuf,

    #[arg(
        long,
        default_value = "packages/runtime/bin/build-client.mjs",
        help = "Client bundler script path, relative to the current directory unless absolute"
    )]
    client_bundler: PathBuf,
}

#[derive(Debug, Args)]
struct ServeArgs {
    #[arg(
        long,
        default_value = ".",
        help = "Project root containing tsconfig.json"
    )]
    project: PathBuf,

    #[arg(
        long,
        default_value = "app",
        help = "App directory, relative to --project unless absolute"
    )]
    app: PathBuf,

    #[arg(
        long,
        default_value = ".ferrite/types/routes.d.ts",
        help = "Generated route types path, relative to --project unless absolute"
    )]
    types_out: PathBuf,

    #[arg(long, default_value = "127.0.0.1", help = "Host address to bind")]
    host: String,

    #[arg(long, default_value_t = 3000, help = "Port to bind")]
    port: u16,

    #[arg(
        long,
        help = "Serve one synthetic GET request and exit, useful for checks"
    )]
    once: bool,

    #[arg(long, default_value = "/", help = "Request path used with --once")]
    request_path: String,

    #[arg(
        long,
        default_value = ".ferrite/server/static",
        help = "Generated client asset directory, relative to --project unless absolute"
    )]
    client_out: PathBuf,

    #[arg(
        long,
        default_value = "/_ferrite/static",
        help = "Public URL prefix for generated client assets"
    )]
    client_public_path: String,

    #[arg(
        long,
        default_value = "packages/runtime/bin/render-page.mjs",
        help = "Page renderer script path, relative to the current directory unless absolute"
    )]
    page_renderer: PathBuf,

    #[arg(
        long,
        default_value = "packages/runtime/bin/build-client.mjs",
        help = "Client bundler script path, relative to the current directory unless absolute"
    )]
    client_bundler: PathBuf,

    #[arg(
        long,
        default_value_t = 30_000,
        help = "Maximum milliseconds allowed for each production renderer or client-bundler subprocess"
    )]
    render_timeout_ms: u64,

    #[arg(
        long,
        default_value_t = 5_000,
        help = "Maximum milliseconds to wait while reading each production HTTP request"
    )]
    request_read_timeout_ms: u64,

    #[arg(
        long,
        default_value_t = 16_384,
        help = "Maximum bytes allowed for each production HTTP request header and body"
    )]
    max_request_bytes: usize,

    #[arg(
        long,
        default_value_t = 64,
        help = "Maximum production requests handled concurrently"
    )]
    max_in_flight_requests: usize,

    #[arg(
        long,
        help = "Environment variable containing the server-action CSRF token required for action POSTs"
    )]
    server_action_csrf_token_env: Option<String>,

    #[arg(
        long,
        help = "Cookie name used to bind server-action CSRF POSTs to the rendered CSRF token"
    )]
    server_action_csrf_cookie_name: Option<String>,

    #[arg(
        long,
        help = "Milliseconds that rendered production server-action replay nonces remain valid; requires --server-action-csrf-token-env"
    )]
    server_action_replay_ttl_ms: Option<u64>,

    #[arg(
        long,
        help = "Trusted public HTTP(S) origin for server-action POSTs behind a reverse proxy; requires matching X-Forwarded-Proto and X-Forwarded-Host"
    )]
    trusted_proxy_public_origin: Option<String>,

    #[arg(
        long,
        help = "Trust X-Forwarded-For for access-log client_ip after this many trusted proxy hops; requires --trusted-proxy-public-origin"
    )]
    trusted_proxy_client_ip_hops: Option<usize>,

    #[arg(
        long,
        value_enum,
        help = "Emit production request access logs to stderr in the selected format"
    )]
    access_log: Option<AccessLogFormat>,

    #[arg(
        long,
        value_enum,
        help = "Emit production server-action audit logs to stderr in the selected format"
    )]
    action_log: Option<AccessLogFormat>,

    #[arg(
        long,
        help = "Expose in-memory production request/action counters as Prometheus text at this absolute path"
    )]
    metrics_path: Option<String>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, ValueEnum)]
enum AccessLogFormat {
    Plain,
    Json,
}

#[derive(Debug, Args)]
struct BuildArgs {
    #[arg(
        long,
        default_value = ".",
        help = "Project root containing the app directory"
    )]
    project: PathBuf,

    #[arg(
        long,
        default_value = "app",
        help = "App directory, relative to --project unless absolute"
    )]
    app: PathBuf,

    #[arg(
        long,
        default_value = ".ferrite/build",
        help = "Build output directory, relative to --project unless absolute"
    )]
    out: PathBuf,

    #[arg(
        long,
        default_value = ".ferrite/types/routes.d.ts",
        help = "Generated route types path, relative to --project unless absolute"
    )]
    types_out: PathBuf,

    #[arg(
        long,
        default_value = "packages/runtime/bin/render-page.mjs",
        help = "Page renderer script path, relative to the current directory unless absolute"
    )]
    page_renderer: PathBuf,

    #[arg(
        long,
        default_value = "packages/runtime/bin/build-client.mjs",
        help = "Client bundler script path, relative to the current directory unless absolute"
    )]
    client_bundler: PathBuf,
}

#[derive(Debug)]
pub enum CliError {
    Builder(ferrite_builder::BuildError),
    DevServer(ferrite_dev_server::DevServerError),
    Router(ferrite_router::RouterError),
    Io(std::io::Error),
    Json(serde_json::Error),
    Ssr(ferrite_ssr::SsrError),
    MissingTsConfig(PathBuf),
    TypeScriptNotFound(PathBuf),
    TypeScriptFailed(Option<i32>),
    Config(String),
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            CliError::MissingTsConfig(_)
            | CliError::TypeScriptNotFound(_)
            | CliError::Config(_) => 2,
            _ => 1,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Builder(error) => write!(f, "{error}"),
            CliError::DevServer(error) => write!(f, "{error}"),
            CliError::Router(error) => write!(f, "{error}"),
            CliError::Io(error) => write!(f, "{error}"),
            CliError::Json(error) => write!(f, "{error}"),
            CliError::Ssr(error) => write!(f, "{error}"),
            CliError::MissingTsConfig(path) => {
                write!(f, "missing TypeScript config: {}", path.display())
            }
            CliError::TypeScriptNotFound(project) => write!(
                f,
                "could not find TypeScript compiler; install dependencies in {} or put `tsc` on PATH",
                project.display()
            ),
            CliError::TypeScriptFailed(code) => match code {
                Some(code) => write!(f, "TypeScript check failed with exit code {code}"),
                None => write!(f, "TypeScript check was terminated by signal"),
            },
            CliError::Config(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<ferrite_router::RouterError> for CliError {
    fn from(error: ferrite_router::RouterError) -> Self {
        CliError::Router(error)
    }
}

impl From<ferrite_dev_server::DevServerError> for CliError {
    fn from(error: ferrite_dev_server::DevServerError) -> Self {
        CliError::DevServer(error)
    }
}

impl From<ferrite_builder::BuildError> for CliError {
    fn from(error: ferrite_builder::BuildError) -> Self {
        CliError::Builder(error)
    }
}

impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        CliError::Io(error)
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        CliError::Json(error)
    }
}

impl From<ferrite_ssr::SsrError> for CliError {
    fn from(error: ferrite_ssr::SsrError) -> Self {
        CliError::Ssr(error)
    }
}

pub type Result<T> = std::result::Result<T, CliError>;

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    run_cli(cli)
}

fn run_cli(cli: Cli) -> Result<()> {
    let _plain = cli.plain;
    let _no_color = cli.no_color;

    match cli.command {
        Commands::Routes(args) => {
            let project = normalize_project_path(&args.project)?;
            let app_dir = resolve_project_path(&project, &args.app);
            let routes = scan_app_dir(&app_dir)?;

            let types_out = args
                .types_out
                .as_ref()
                .map(|path| resolve_project_path(&project, path));
            if let Some(types_out) = &types_out {
                write_route_types(&routes, types_out)?;
            }

            if cli.json {
                print_json(&RoutesOutput {
                    project,
                    app_dir,
                    types_out,
                    routes,
                })?;
            } else {
                print_routes(&project, &app_dir, types_out.as_deref(), &routes);
            }
        }
        Commands::Check(args) => {
            let project = normalize_project_path(&args.project)?;
            let app_dir = resolve_project_path(&project, &args.app);
            let types_out = resolve_project_path(&project, &args.types_out);
            let routes = scan_app_dir(&app_dir)?;
            write_route_types(&routes, &types_out)?;

            let typecheck = if args.skip_typescript {
                TypecheckStatus::Skipped
            } else {
                run_typescript_check(&project)?;
                TypecheckStatus::Passed
            };

            if cli.json {
                print_json(&CheckOutput {
                    project,
                    app_dir,
                    types_out,
                    routes,
                    typecheck,
                })?;
            } else {
                println!("Ferrite check passed");
                println!("routes: {}", routes.len());
                println!("route types: {}", types_out.display());
                match typecheck {
                    TypecheckStatus::Passed => println!("typescript: passed"),
                    TypecheckStatus::Skipped => println!("typescript: skipped"),
                }
            }
        }
        Commands::Render(args) => {
            let input = read_input(&args.input)?;
            let html = ferrite_ssr::render_json_to_html(&input)?;

            if cli.json {
                print_json(&RenderOutput { html })?;
            } else {
                println!("{html}");
            }
        }
        Commands::Dev(args) => {
            let project = normalize_project_path(&args.project)?;
            let app_dir = resolve_project_path(&project, &args.app);
            let types_out = resolve_project_path(&project, &args.types_out);
            let page_renderer = normalize_current_path(&args.page_renderer)?;
            let client_bundler = normalize_current_path(&args.client_bundler)?;
            let mut dev_project = DevProject::new(DevServerConfig::new(
                project.clone(),
                app_dir.clone(),
                types_out.clone(),
                page_renderer.clone(),
                client_bundler.clone(),
                project.join(".ferrite/dev/static"),
                "/_ferrite/static".to_owned(),
            ));

            if args.once {
                let response = dev_project.handle_get(&args.request_path)?;
                if cli.json {
                    print_json(&DevOnceOutput {
                        project,
                        app_dir,
                        types_out,
                        page_renderer,
                        client_bundler,
                        response: response.into(),
                        build_id: dev_project.build_id()?,
                    })?;
                } else {
                    std::io::stdout().write_all(&response.body)?;
                }
            } else {
                let addr = format!("{}:{}", args.host, args.port);
                if cli.json {
                    print_json(&DevStartedOutput {
                        project: &project,
                        app_dir: &app_dir,
                        types_out: &types_out,
                        page_renderer: &page_renderer,
                        client_bundler: &client_bundler,
                        url: format!("http://{addr}"),
                    })?;
                } else {
                    eprintln!("Ferrite dev server listening on http://{addr}");
                    eprintln!("project: {}", project.display());
                    eprintln!("app: {}", app_dir.display());
                    eprintln!("route types: {}", types_out.display());
                    eprintln!("page renderer: {}", page_renderer.display());
                    eprintln!("client bundler: {}", client_bundler.display());
                }
                ferrite_dev_server::serve(addr, dev_project)?;
            }
        }
        Commands::Serve(args) => {
            let project = normalize_project_path(&args.project)?;
            let app_dir = resolve_project_path(&project, &args.app);
            let types_out = resolve_project_path(&project, &args.types_out);
            let client_out = resolve_project_path(&project, &args.client_out);
            let page_renderer = normalize_current_path(&args.page_renderer)?;
            let client_bundler = normalize_current_path(&args.client_bundler)?;
            let server_action_csrf_token =
                resolve_server_action_csrf_token(args.server_action_csrf_token_env.as_deref())?;
            let server_action_csrf_cookie_name = resolve_server_action_csrf_cookie_name(
                args.server_action_csrf_cookie_name.as_deref(),
                server_action_csrf_token.as_deref(),
            )?;
            let server_action_replay_ttl = resolve_server_action_replay_ttl(
                args.server_action_replay_ttl_ms,
                server_action_csrf_token.as_deref(),
            )?;
            let trusted_proxy =
                resolve_trusted_proxy_public_origin(args.trusted_proxy_public_origin.as_deref())?;
            let trusted_proxy_client_ip_hops = resolve_trusted_proxy_client_ip_hops(
                args.trusted_proxy_client_ip_hops,
                trusted_proxy.is_some(),
            )?;
            let metrics_path = resolve_metrics_path(args.metrics_path.as_deref())?;
            let mut config = ProductionServerConfig::new(
                project.clone(),
                app_dir.clone(),
                types_out.clone(),
                page_renderer.clone(),
                client_bundler.clone(),
                client_out.clone(),
                args.client_public_path.clone(),
            )
            .with_render_timeout(Duration::from_millis(args.render_timeout_ms))
            .with_request_read_timeout(Duration::from_millis(args.request_read_timeout_ms))
            .with_max_request_bytes(args.max_request_bytes)
            .with_max_in_flight_requests(args.max_in_flight_requests);
            if let Some(token) = server_action_csrf_token {
                config = config.with_server_action_csrf_token(token);
            }
            if let Some(cookie_name) = server_action_csrf_cookie_name {
                config = config.with_server_action_csrf_cookie_name(cookie_name);
            }
            if let Some(ttl) = server_action_replay_ttl {
                config = config.with_server_action_replay_ttl(ttl);
            }
            if let Some(trusted_proxy) = trusted_proxy {
                config = config.with_trusted_proxy(trusted_proxy);
            }
            if let Some(hops) = trusted_proxy_client_ip_hops {
                config = config.with_trusted_proxy_client_ip_hops(hops);
            }
            if let Some(metrics_path) = metrics_path {
                config = config.with_metrics_path(metrics_path);
            }
            if let Some(format) = args.access_log {
                config = config.with_request_observer(move |event| {
                    eprintln!("{}", format_access_log_event(&event, format));
                });
            }
            if let Some(format) = args.action_log {
                config = config.with_action_observer(move |event| {
                    eprintln!("{}", format_action_log_event(&event, format));
                });
            }
            let mut production_project = ProductionProject::new(config);
            let production_limits = ServeLimitsOutput::from(production_project.config());

            if args.once {
                let response = production_project.handle_get(&args.request_path)?;
                if cli.json {
                    print_json(&ServeOnceOutput {
                        project,
                        app_dir,
                        types_out,
                        client_out,
                        client_public_path: args.client_public_path,
                        page_renderer,
                        client_bundler,
                        render_timeout_ms: production_limits.render_timeout_ms,
                        request_read_timeout_ms: production_limits.request_read_timeout_ms,
                        max_request_bytes: production_limits.max_request_bytes,
                        max_in_flight_requests: production_limits.max_in_flight_requests,
                        response: response.into(),
                    })?;
                } else {
                    std::io::stdout().write_all(&response.body)?;
                }
            } else {
                let addr = format!("{}:{}", args.host, args.port);
                if cli.json {
                    print_json(&ServeStartedOutput {
                        project: &project,
                        app_dir: &app_dir,
                        types_out: &types_out,
                        client_out: &client_out,
                        client_public_path: &args.client_public_path,
                        page_renderer: &page_renderer,
                        client_bundler: &client_bundler,
                        render_timeout_ms: production_limits.render_timeout_ms,
                        request_read_timeout_ms: production_limits.request_read_timeout_ms,
                        max_request_bytes: production_limits.max_request_bytes,
                        max_in_flight_requests: production_limits.max_in_flight_requests,
                        url: format!("http://{addr}"),
                    })?;
                } else {
                    eprintln!("Ferrite production server listening on http://{addr}");
                    eprintln!("project: {}", project.display());
                    eprintln!("app: {}", app_dir.display());
                    eprintln!("route types: {}", types_out.display());
                    eprintln!("client out: {}", client_out.display());
                    eprintln!("client public path: {}", args.client_public_path);
                    eprintln!("page renderer: {}", page_renderer.display());
                    eprintln!("client bundler: {}", client_bundler.display());
                    eprintln!("render timeout ms: {}", production_limits.render_timeout_ms);
                    eprintln!(
                        "request read timeout ms: {}",
                        production_limits.request_read_timeout_ms
                    );
                    eprintln!("max request bytes: {}", production_limits.max_request_bytes);
                    eprintln!(
                        "max in-flight requests: {}",
                        production_limits.max_in_flight_requests
                    );
                }
                ferrite_dev_server::serve_production(addr, production_project)?;
            }
        }
        Commands::Build(args) => {
            let project = normalize_project_path(&args.project)?;
            let app_dir = resolve_project_path(&project, &args.app);
            let out_dir = resolve_project_path(&project, &args.out);
            let types_out = resolve_project_path(&project, &args.types_out);
            let page_renderer = normalize_current_path(&args.page_renderer)?;
            let client_bundler = normalize_current_path(&args.client_bundler)?;
            let report = ferrite_builder::build_project(&BuildConfig::new(
                project,
                app_dir,
                out_dir,
                types_out,
                page_renderer,
                client_bundler,
            ))?;

            if cli.json {
                print_json(&report)?;
            } else {
                print_build_report(&report);
            }
        }
    }

    Ok(())
}

fn read_input(path: &Path) -> Result<String> {
    if path == Path::new("-") {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input)?;
        Ok(input)
    } else {
        Ok(std::fs::read_to_string(path)?)
    }
}

fn normalize_project_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn normalize_current_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn resolve_project_path(project: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        project.join(path)
    }
}

fn print_routes(project: &Path, app_dir: &Path, types_out: Option<&Path>, routes: &[Route]) {
    println!("project: {}", project.display());
    println!("app: {}", app_dir.display());
    for route in routes {
        println!("{} -> {}", route.path, route.file.display());
    }
    if let Some(types_out) = types_out {
        println!("route types: {}", types_out.display());
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_build_report(report: &BuildReport) {
    println!("Ferrite build complete");
    println!("out: {}", report.out_dir.display());
    println!("routes: {}", report.routes_count);
    println!("html files: {}", report.html_files.len());
    println!("client bundles: {}", report.client_bundles.len());
    println!(
        "server action manifests: {}",
        report.server_action_manifests.len()
    );
    println!(
        "skipped dynamic routes: {}",
        report.skipped_dynamic_routes.len()
    );
    println!("manifest: {}", report.manifest_file.display());
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn resolve_server_action_csrf_token(env_name: Option<&str>) -> Result<Option<String>> {
    let Some(env_name) = env_name else {
        return Ok(None);
    };
    if env_name.trim().is_empty() {
        return Err(CliError::Config(
            "--server-action-csrf-token-env requires a non-empty environment variable name"
                .to_owned(),
        ));
    }

    let value = env::var(env_name).map_err(|error| {
        CliError::Config(format!(
            "could not read server action CSRF token from `{env_name}`: {error}"
        ))
    })?;
    if value.is_empty() {
        return Err(CliError::Config(format!(
            "server action CSRF token environment variable `{env_name}` must not be empty"
        )));
    }

    Ok(Some(value))
}

fn resolve_server_action_csrf_cookie_name(
    cookie_name: Option<&str>,
    csrf_token: Option<&str>,
) -> Result<Option<String>> {
    let Some(cookie_name) = cookie_name else {
        return Ok(None);
    };
    if csrf_token.is_none() {
        return Err(CliError::Config(
            "--server-action-csrf-cookie-name requires --server-action-csrf-token-env".to_owned(),
        ));
    }
    if !is_valid_cookie_name(cookie_name) {
        return Err(CliError::Config(
            "--server-action-csrf-cookie-name must be a non-empty RFC6265 cookie name".to_owned(),
        ));
    }
    let csrf_token = csrf_token.expect("checked above");
    if !is_valid_cookie_value(csrf_token) {
        return Err(CliError::Config(
            "server action CSRF token must be cookie-safe when --server-action-csrf-cookie-name is used".to_owned(),
        ));
    }
    Ok(Some(cookie_name.to_owned()))
}

fn resolve_server_action_replay_ttl(
    ttl_ms: Option<u64>,
    csrf_token: Option<&str>,
) -> Result<Option<Duration>> {
    let Some(ttl_ms) = ttl_ms else {
        return Ok(None);
    };
    if csrf_token.is_none() {
        return Err(CliError::Config(
            "--server-action-replay-ttl-ms requires --server-action-csrf-token-env".to_owned(),
        ));
    }
    if ttl_ms == 0 {
        return Err(CliError::Config(
            "--server-action-replay-ttl-ms must be at least 1".to_owned(),
        ));
    }
    Ok(Some(Duration::from_millis(ttl_ms)))
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

fn resolve_trusted_proxy_public_origin(
    public_origin: Option<&str>,
) -> Result<Option<ProductionTrustedProxyConfig>> {
    let Some(public_origin) = public_origin else {
        return Ok(None);
    };
    if public_origin.trim().is_empty() {
        return Err(CliError::Config(
            "--trusted-proxy-public-origin requires a non-empty HTTP(S) origin".to_owned(),
        ));
    }
    ProductionTrustedProxyConfig::new(public_origin)
        .map(Some)
        .map_err(|message| {
            CliError::Config(format!("invalid trusted proxy public origin: {message}"))
        })
}

fn resolve_trusted_proxy_client_ip_hops(
    hops: Option<usize>,
    trusted_proxy_configured: bool,
) -> Result<Option<usize>> {
    let Some(hops) = hops else {
        return Ok(None);
    };
    if !trusted_proxy_configured {
        return Err(CliError::Config(
            "--trusted-proxy-client-ip-hops requires --trusted-proxy-public-origin".to_owned(),
        ));
    }
    if hops == 0 {
        return Err(CliError::Config(
            "--trusted-proxy-client-ip-hops must be at least 1".to_owned(),
        ));
    }
    Ok(Some(hops))
}

fn resolve_metrics_path(path: Option<&str>) -> Result<Option<String>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if path.trim().is_empty() || !path.starts_with('/') {
        return Err(CliError::Config(
            "--metrics-path requires an absolute path starting with `/`".to_owned(),
        ));
    }
    if path.contains('?') || path.contains('#') {
        return Err(CliError::Config(
            "--metrics-path must not contain a query string or fragment".to_owned(),
        ));
    }
    if path == "/_ferrite/action" {
        return Err(CliError::Config(
            "--metrics-path must not shadow the server-action endpoint".to_owned(),
        ));
    }
    Ok(Some(path.to_owned()))
}

fn run_typescript_check(project: &Path) -> Result<()> {
    let tsconfig = project.join("tsconfig.json");
    if !tsconfig.is_file() {
        return Err(CliError::MissingTsConfig(tsconfig));
    }

    let tsc =
        find_tsc(project).ok_or_else(|| CliError::TypeScriptNotFound(project.to_path_buf()))?;
    let status = Command::new(tsc)
        .arg("--noEmit")
        .arg("--project")
        .arg(&tsconfig)
        .current_dir(project)
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err(CliError::TypeScriptFailed(status.code()))
    }
}

fn find_tsc(project: &Path) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "tsc.cmd" } else { "tsc" };

    for dir in project.ancestors() {
        let local = dir.join("node_modules").join(".bin").join(bin_name);
        if local.is_file() {
            return Some(local);
        }
    }

    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin_name))
            .find(|candidate| candidate.is_file())
    })
}

fn format_access_log_event(event: &ProductionRequestEvent, format: AccessLogFormat) -> String {
    let output = AccessLogEventOutput::from(event);
    match format {
        AccessLogFormat::Plain => {
            let route = output.route_pattern.unwrap_or("-");
            let client_ip = output.client_ip.unwrap_or("-");
            format!(
                "method={} path={} status={} route={} client_ip={} elapsed_ms={}",
                output.method, output.path, output.status, route, client_ip, output.elapsed_ms
            )
        }
        AccessLogFormat::Json => {
            serde_json::to_string(&output).expect("access log event output is serializable")
        }
    }
}

fn format_action_log_event(event: &ProductionActionEvent, format: AccessLogFormat) -> String {
    let output = ActionLogEventOutput::from(event);
    match format {
        AccessLogFormat::Plain => {
            let action = output.action_id.unwrap_or("-");
            let route = output.route_path.unwrap_or("-");
            let pattern = output.route_pattern.unwrap_or("-");
            let client_ip = output.client_ip.unwrap_or("-");
            format!(
                "action={} route={} pattern={} status={} outcome={} client_ip={} elapsed_ms={}",
                action,
                route,
                pattern,
                output.status,
                action_outcome_str(output.outcome),
                client_ip,
                output.elapsed_ms
            )
        }
        AccessLogFormat::Json => {
            serde_json::to_string(&output).expect("action log event output is serializable")
        }
    }
}

#[derive(Debug, Serialize)]
struct RoutesOutput {
    project: PathBuf,
    app_dir: PathBuf,
    types_out: Option<PathBuf>,
    routes: Vec<Route>,
}

#[derive(Debug, Serialize)]
struct CheckOutput {
    project: PathBuf,
    app_dir: PathBuf,
    types_out: PathBuf,
    routes: Vec<Route>,
    typecheck: TypecheckStatus,
}

#[derive(Debug, Serialize)]
struct RenderOutput {
    html: String,
}

#[derive(Debug, Serialize)]
struct DevOnceOutput {
    project: PathBuf,
    app_dir: PathBuf,
    types_out: PathBuf,
    page_renderer: PathBuf,
    client_bundler: PathBuf,
    response: DevResponseOutput,
    build_id: u64,
}

#[derive(Debug, Serialize)]
struct DevStartedOutput<'a> {
    project: &'a Path,
    app_dir: &'a Path,
    types_out: &'a Path,
    page_renderer: &'a Path,
    client_bundler: &'a Path,
    url: String,
}

#[derive(Debug, Serialize)]
struct ServeOnceOutput {
    project: PathBuf,
    app_dir: PathBuf,
    types_out: PathBuf,
    client_out: PathBuf,
    client_public_path: String,
    page_renderer: PathBuf,
    client_bundler: PathBuf,
    render_timeout_ms: u64,
    request_read_timeout_ms: u64,
    max_request_bytes: usize,
    max_in_flight_requests: usize,
    response: DevResponseOutput,
}

#[derive(Debug, Serialize)]
struct ServeStartedOutput<'a> {
    project: &'a Path,
    app_dir: &'a Path,
    types_out: &'a Path,
    client_out: &'a Path,
    client_public_path: &'a str,
    page_renderer: &'a Path,
    client_bundler: &'a Path,
    render_timeout_ms: u64,
    request_read_timeout_ms: u64,
    max_request_bytes: usize,
    max_in_flight_requests: usize,
    url: String,
}

#[derive(Debug, Serialize)]
struct AccessLogEventOutput<'a> {
    method: &'a str,
    path: &'a str,
    status: u16,
    route_pattern: Option<&'a str>,
    client_ip: Option<&'a str>,
    elapsed_ms: u64,
}

impl<'a> From<&'a ProductionRequestEvent> for AccessLogEventOutput<'a> {
    fn from(event: &'a ProductionRequestEvent) -> Self {
        Self {
            method: &event.method,
            path: &event.path,
            status: event.status,
            route_pattern: event.route_pattern.as_deref(),
            client_ip: event.client_ip.as_deref(),
            elapsed_ms: duration_millis_u64(event.elapsed),
        }
    }
}

#[derive(Debug, Serialize)]
struct ActionLogEventOutput<'a> {
    action_id: Option<&'a str>,
    route_path: Option<&'a str>,
    route_pattern: Option<&'a str>,
    status: u16,
    outcome: ProductionActionOutcome,
    client_ip: Option<&'a str>,
    elapsed_ms: u64,
}

impl<'a> From<&'a ProductionActionEvent> for ActionLogEventOutput<'a> {
    fn from(event: &'a ProductionActionEvent) -> Self {
        Self {
            action_id: event.action_id.as_deref(),
            route_path: event.route_path.as_deref(),
            route_pattern: event.route_pattern.as_deref(),
            status: event.status,
            outcome: event.outcome,
            client_ip: event.client_ip.as_deref(),
            elapsed_ms: duration_millis_u64(event.elapsed),
        }
    }
}

fn action_outcome_str(outcome: ProductionActionOutcome) -> &'static str {
    match outcome {
        ProductionActionOutcome::Accepted => "accepted",
        ProductionActionOutcome::Rejected => "rejected",
    }
}

#[derive(Debug, Copy, Clone, Serialize)]
struct ServeLimitsOutput {
    render_timeout_ms: u64,
    request_read_timeout_ms: u64,
    max_request_bytes: usize,
    max_in_flight_requests: usize,
}

impl ServeLimitsOutput {
    fn from(config: &ProductionServerConfig) -> Self {
        Self {
            render_timeout_ms: duration_millis_u64(config.render_timeout),
            request_read_timeout_ms: duration_millis_u64(config.request_read_timeout),
            max_request_bytes: config.max_request_bytes,
            max_in_flight_requests: config.max_in_flight_requests,
        }
    }
}

#[derive(Debug, Serialize)]
struct DevResponseOutput {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    cache_control: Option<&'static str>,
    route_pattern: Option<String>,
    body: String,
}

impl From<DevResponse> for DevResponseOutput {
    fn from(response: DevResponse) -> Self {
        Self {
            status: response.status,
            reason: response.reason,
            content_type: response.content_type,
            cache_control: response.cache_control,
            route_pattern: response.route_pattern_header,
            body: String::from_utf8_lossy(&response.body).into_owned(),
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum TypecheckStatus {
    Passed,
    Skipped,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_project_paths() {
        let cwd = std::env::current_dir().unwrap();
        let path = normalize_project_path(Path::new("examples/basic")).unwrap();
        assert_eq!(path, cwd.join("examples/basic"));
    }

    #[test]
    fn reports_missing_tsconfig_as_usage_error() {
        let temp = tempfile::tempdir().unwrap();
        let error = run_typescript_check(temp.path()).unwrap_err();

        assert!(matches!(error, CliError::MissingTsConfig(_)));
        assert_eq!(error.exit_code(), 2);
    }

    #[test]
    fn serve_accepts_render_timeout_ms() {
        let cli = Cli::try_parse_from(["ferrite", "serve", "--render-timeout-ms", "250", "--once"])
            .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.render_timeout_ms, 250);
    }

    #[test]
    fn serve_accepts_production_limit_flags() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--request-read-timeout-ms",
            "750",
            "--max-request-bytes",
            "4096",
            "--max-in-flight-requests",
            "8",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.request_read_timeout_ms, 750);
        assert_eq!(args.max_request_bytes, 4096);
        assert_eq!(args.max_in_flight_requests, 8);
    }

    #[test]
    fn serve_accepts_server_action_csrf_token_env_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--server-action-csrf-token-env",
            "FERRITE_ACTION_CSRF",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(
            args.server_action_csrf_token_env.as_deref(),
            Some("FERRITE_ACTION_CSRF")
        );
    }

    #[test]
    fn serve_accepts_server_action_csrf_cookie_name_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--server-action-csrf-cookie-name",
            "ferrite_action_csrf",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(
            args.server_action_csrf_cookie_name.as_deref(),
            Some("ferrite_action_csrf")
        );
    }

    #[test]
    fn serve_accepts_server_action_replay_ttl_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--server-action-replay-ttl-ms",
            "300000",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.server_action_replay_ttl_ms, Some(300_000));
    }

    #[test]
    fn serve_accepts_trusted_proxy_public_origin_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--trusted-proxy-public-origin",
            "https://app.example.com",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(
            args.trusted_proxy_public_origin.as_deref(),
            Some("https://app.example.com")
        );
    }

    #[test]
    fn serve_accepts_trusted_proxy_client_ip_hops_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--trusted-proxy-public-origin",
            "https://app.example.com",
            "--trusted-proxy-client-ip-hops",
            "2",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.trusted_proxy_client_ip_hops, Some(2));
    }

    #[test]
    fn serve_accepts_access_log_format_flag() {
        let cli =
            Cli::try_parse_from(["ferrite", "serve", "--access-log", "json", "--once"]).unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.access_log, Some(AccessLogFormat::Json));
    }

    #[test]
    fn serve_accepts_action_log_format_flag() {
        let cli =
            Cli::try_parse_from(["ferrite", "serve", "--action-log", "json", "--once"]).unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.action_log, Some(AccessLogFormat::Json));
    }

    #[test]
    fn serve_accepts_metrics_path_flag() {
        let cli = Cli::try_parse_from([
            "ferrite",
            "serve",
            "--metrics-path",
            "/__ferrite/metrics",
            "--once",
        ])
        .unwrap();

        let Commands::Serve(args) = cli.command else {
            panic!("expected serve command");
        };
        assert_eq!(args.metrics_path.as_deref(), Some("/__ferrite/metrics"));
    }

    #[test]
    fn formats_access_log_events_without_headers_or_body() {
        let event = ProductionRequestEvent {
            method: "POST".to_owned(),
            path: "/_ferrite/action".to_owned(),
            status: 403,
            route_pattern: Some("/posts/[id]".to_owned()),
            client_ip: Some("203.0.113.10".to_owned()),
            elapsed: Duration::from_millis(17),
        };

        assert_eq!(
            format_access_log_event(&event, AccessLogFormat::Plain),
            "method=POST path=/_ferrite/action status=403 route=/posts/[id] client_ip=203.0.113.10 elapsed_ms=17"
        );

        let json: serde_json::Value =
            serde_json::from_str(&format_access_log_event(&event, AccessLogFormat::Json)).unwrap();
        assert_eq!(json["method"], "POST");
        assert_eq!(json["path"], "/_ferrite/action");
        assert_eq!(json["status"], 403);
        assert_eq!(json["route_pattern"], "/posts/[id]");
        assert_eq!(json["client_ip"], "203.0.113.10");
        assert_eq!(json["elapsed_ms"], 17);
        assert!(json.get("headers").is_none());
        assert!(json.get("body").is_none());
    }

    #[test]
    fn formats_action_log_events_without_form_data_or_tokens() {
        let event = ProductionActionEvent {
            action_id: Some("app/posts/[id]/page.tsx#savePost".to_owned()),
            route_path: Some("/posts/abc".to_owned()),
            route_pattern: Some("/posts/[id]".to_owned()),
            status: 403,
            outcome: ProductionActionOutcome::Rejected,
            client_ip: Some("203.0.113.10".to_owned()),
            elapsed: Duration::from_millis(19),
        };

        assert_eq!(
            format_action_log_event(&event, AccessLogFormat::Plain),
            "action=app/posts/[id]/page.tsx#savePost route=/posts/abc pattern=/posts/[id] status=403 outcome=rejected client_ip=203.0.113.10 elapsed_ms=19"
        );

        let json: serde_json::Value =
            serde_json::from_str(&format_action_log_event(&event, AccessLogFormat::Json)).unwrap();
        assert_eq!(json["action_id"], "app/posts/[id]/page.tsx#savePost");
        assert_eq!(json["route_path"], "/posts/abc");
        assert_eq!(json["route_pattern"], "/posts/[id]");
        assert_eq!(json["status"], 403);
        assert_eq!(json["outcome"], "rejected");
        assert_eq!(json["client_ip"], "203.0.113.10");
        assert_eq!(json["elapsed_ms"], 19);
        assert!(json.get("form").is_none());
        assert!(json.get("headers").is_none());
        assert!(json.get("csrf").is_none());
        assert!(json.get("body").is_none());
    }

    #[test]
    fn server_action_csrf_token_env_requires_existing_non_empty_value() {
        let missing_env = format!("FERRITE_MISSING_CSRF_TOKEN_FOR_TEST_{}", std::process::id());
        let missing = resolve_server_action_csrf_token(Some(&missing_env)).unwrap_err();
        assert!(matches!(missing, CliError::Config(_)));
        assert_eq!(missing.exit_code(), 2);

        let empty = resolve_server_action_csrf_token(Some("")).unwrap_err();
        assert!(matches!(empty, CliError::Config(_)));
        assert_eq!(empty.exit_code(), 2);
    }

    #[test]
    fn server_action_csrf_cookie_name_requires_token_and_cookie_safe_values() {
        let missing_token =
            resolve_server_action_csrf_cookie_name(Some("ferrite_action_csrf"), None).unwrap_err();
        assert!(matches!(missing_token, CliError::Config(_)));
        assert_eq!(missing_token.exit_code(), 2);

        let valid =
            resolve_server_action_csrf_cookie_name(Some("ferrite_action_csrf"), Some("token-123"))
                .unwrap();
        assert_eq!(valid.as_deref(), Some("ferrite_action_csrf"));

        let bad_name = resolve_server_action_csrf_cookie_name(Some("bad name"), Some("token-123"))
            .unwrap_err();
        assert!(matches!(bad_name, CliError::Config(_)));
        assert_eq!(bad_name.exit_code(), 2);

        let bad_token =
            resolve_server_action_csrf_cookie_name(Some("ferrite_action_csrf"), Some("bad;token"))
                .unwrap_err();
        assert!(matches!(bad_token, CliError::Config(_)));
        assert_eq!(bad_token.exit_code(), 2);
    }

    #[test]
    fn server_action_replay_ttl_requires_token_and_positive_duration() {
        let missing_token = resolve_server_action_replay_ttl(Some(30_000), None).unwrap_err();
        assert!(matches!(missing_token, CliError::Config(_)));
        assert_eq!(missing_token.exit_code(), 2);

        let zero = resolve_server_action_replay_ttl(Some(0), Some("token-123")).unwrap_err();
        assert!(matches!(zero, CliError::Config(_)));
        assert_eq!(zero.exit_code(), 2);

        assert_eq!(
            resolve_server_action_replay_ttl(Some(30_000), Some("token-123")).unwrap(),
            Some(Duration::from_millis(30_000))
        );
        assert_eq!(
            resolve_server_action_replay_ttl(None, Some("token-123")).unwrap(),
            None
        );
    }

    #[test]
    fn trusted_proxy_public_origin_requires_valid_http_origin() {
        let config = resolve_trusted_proxy_public_origin(Some("https://app.example.com")).unwrap();
        let config = config.expect("trusted proxy config should be built");
        assert_eq!(config.public_origin(), "https://app.example.com");

        let with_path =
            resolve_trusted_proxy_public_origin(Some("https://app.example.com/path")).unwrap_err();
        assert!(matches!(with_path, CliError::Config(_)));
        assert_eq!(with_path.exit_code(), 2);

        let unsupported_scheme =
            resolve_trusted_proxy_public_origin(Some("ftp://app.example.com")).unwrap_err();
        assert!(matches!(unsupported_scheme, CliError::Config(_)));
        assert_eq!(unsupported_scheme.exit_code(), 2);
    }

    #[test]
    fn trusted_proxy_client_ip_hops_requires_positive_value() {
        assert_eq!(
            resolve_trusted_proxy_client_ip_hops(Some(2), true).unwrap(),
            Some(2)
        );

        let zero = resolve_trusted_proxy_client_ip_hops(Some(0), true).unwrap_err();
        assert!(matches!(zero, CliError::Config(_)));
        assert_eq!(zero.exit_code(), 2);
    }

    #[test]
    fn trusted_proxy_client_ip_hops_requires_trusted_proxy_origin() {
        let missing_proxy = resolve_trusted_proxy_client_ip_hops(Some(1), false).unwrap_err();
        assert!(matches!(missing_proxy, CliError::Config(_)));
        assert_eq!(missing_proxy.exit_code(), 2);
    }

    #[test]
    fn metrics_path_requires_absolute_non_action_path() {
        assert_eq!(
            resolve_metrics_path(Some("/__ferrite/metrics"))
                .unwrap()
                .as_deref(),
            Some("/__ferrite/metrics")
        );

        let relative = resolve_metrics_path(Some("__ferrite/metrics")).unwrap_err();
        assert!(matches!(relative, CliError::Config(_)));
        assert_eq!(relative.exit_code(), 2);

        let query = resolve_metrics_path(Some("/__ferrite/metrics?format=prom")).unwrap_err();
        assert!(matches!(query, CliError::Config(_)));
        assert_eq!(query.exit_code(), 2);

        let action = resolve_metrics_path(Some("/_ferrite/action")).unwrap_err();
        assert!(matches!(action, CliError::Config(_)));
        assert_eq!(action.exit_code(), 2);
    }

    #[test]
    fn serve_limit_output_reports_effective_clamped_values() {
        let config = ProductionServerConfig::new(
            PathBuf::from("project"),
            PathBuf::from("project/app"),
            PathBuf::from("project/.ferrite/types/routes.d.ts"),
            PathBuf::from("render-page.mjs"),
            PathBuf::from("build-client.mjs"),
            PathBuf::from("project/.ferrite/server/static"),
            "/_ferrite/static".to_owned(),
        )
        .with_render_timeout(Duration::ZERO)
        .with_request_read_timeout(Duration::ZERO)
        .with_max_request_bytes(0)
        .with_max_in_flight_requests(0);

        let limits = ServeLimitsOutput::from(&config);

        assert_eq!(limits.render_timeout_ms, 1);
        assert_eq!(limits.request_read_timeout_ms, 1);
        assert_eq!(limits.max_request_bytes, 1);
        assert_eq!(limits.max_in_flight_requests, 1);
    }
}
