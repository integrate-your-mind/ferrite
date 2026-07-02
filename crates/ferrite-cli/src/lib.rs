use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use ferrite_builder::{BuildConfig, BuildReport};
use ferrite_dev_server::{
    DevProject, DevResponse, DevServerConfig, ProductionProject, ProductionServerConfig,
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
    Serve(ServeArgs),

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
        help = "Maximum milliseconds allowed for each production page renderer subprocess"
    )]
    render_timeout_ms: u64,
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
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            CliError::MissingTsConfig(_) | CliError::TypeScriptNotFound(_) => 2,
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
            let mut production_project = ProductionProject::new(
                ProductionServerConfig::new(
                    project.clone(),
                    app_dir.clone(),
                    types_out.clone(),
                    page_renderer.clone(),
                    client_bundler.clone(),
                    client_out.clone(),
                    args.client_public_path.clone(),
                )
                .with_render_timeout(Duration::from_millis(args.render_timeout_ms)),
            );
            let render_timeout_ms = duration_millis_u64(production_project.config().render_timeout);

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
                        render_timeout_ms,
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
                        render_timeout_ms,
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
        "skipped dynamic routes: {}",
        report.skipped_dynamic_routes.len()
    );
    println!("manifest: {}", report.manifest_file.display());
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
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
    url: String,
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
}
