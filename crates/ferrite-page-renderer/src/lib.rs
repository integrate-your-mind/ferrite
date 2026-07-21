use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use ferrite_protocol::{ServerActionReferencePayload, ServerActionRequest, ServerActionResponse};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(not(windows))]
use std::process::Child;

#[cfg(windows)]
use process_wrap::std::{JobObject, StdChildWrapper, StdCommandWrap};

const MIN_RENDER_COMMAND_TIMEOUT: Duration = Duration::from_millis(1);
const RENDER_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const MAX_RENDER_COMMAND_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum PageRenderError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Protocol(ferrite_protocol::ProtocolError),
    Ssr(ferrite_ssr::SsrError),
    NodeFailed { status: Option<i32>, stderr: String },
    Cancelled,
    OutputLimitExceeded { limit: usize },
    TimedOut { timeout: Duration },
}

impl fmt::Display for PageRenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PageRenderError::Io(error) => write!(f, "{error}"),
            PageRenderError::Json(error) => write!(f, "{error}"),
            PageRenderError::Protocol(error) => write!(f, "{error}"),
            PageRenderError::Ssr(error) => write!(f, "{error}"),
            PageRenderError::NodeFailed { status, stderr } => match status {
                Some(status) => write!(f, "page renderer failed with exit code {status}: {stderr}"),
                None => write!(f, "page renderer was terminated: {stderr}"),
            },
            PageRenderError::Cancelled => write!(f, "page renderer was cancelled"),
            PageRenderError::OutputLimitExceeded { limit } => {
                write!(f, "page renderer output exceeded {limit} bytes")
            }
            PageRenderError::TimedOut { timeout } => {
                write!(
                    f,
                    "page renderer timed out after {} ms",
                    timeout.as_millis()
                )
            }
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

impl From<ferrite_protocol::ProtocolError> for PageRenderError {
    fn from(error: ferrite_protocol::ProtocolError) -> Self {
        PageRenderError::Protocol(error)
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
    prebuilt_artifact: bool,
    prebuilt_module_source: Option<Arc<[u8]>>,
    command_timeout: Option<Duration>,
    cancellation_flag: Option<Arc<AtomicBool>>,
    server_action_csrf_token: Option<String>,
    server_action_replay_nonce: Option<String>,
}

impl PageRenderer {
    pub fn new(project: PathBuf, script: PathBuf) -> Self {
        Self {
            project,
            script,
            prebuilt_artifact: false,
            prebuilt_module_source: None,
            command_timeout: None,
            cancellation_flag: None,
            server_action_csrf_token: None,
            server_action_replay_nonce: None,
        }
    }

    pub fn for_prebuilt_artifact(project: PathBuf, script: PathBuf) -> Self {
        Self {
            project,
            script,
            prebuilt_artifact: true,
            prebuilt_module_source: None,
            command_timeout: None,
            cancellation_flag: None,
            server_action_csrf_token: None,
            server_action_replay_nonce: None,
        }
    }

    pub fn build_server_module(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: Option<&Path>,
        conventions: &RouteConventions,
        route_pattern: &str,
        output_file: &Path,
    ) -> Result<()> {
        let layouts_json = serde_json::to_string(layouts)?;
        let document_json = serde_json::to_string(&document_file)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let mut command = Command::new("node");
        command
            .arg(&self.script)
            .arg("--build-artifact")
            .arg(page_file)
            .arg(output_file)
            .arg(layouts_json)
            .arg(document_json)
            .arg(conventions_json)
            .arg(route_pattern)
            .current_dir(&self.project);
        let output = self.run_command(command)?;
        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        Ok(())
    }

    pub fn with_command_timeout(mut self, timeout: Duration) -> Self {
        self.command_timeout = Some(timeout.max(MIN_RENDER_COMMAND_TIMEOUT));
        self
    }

    pub fn with_cancellation_flag(mut self, cancellation_flag: Arc<AtomicBool>) -> Self {
        self.cancellation_flag = Some(cancellation_flag);
        self
    }

    pub fn with_prebuilt_module_source(mut self, source: Arc<[u8]>) -> Self {
        self.prebuilt_module_source = Some(source);
        self
    }

    pub fn without_command_timeout(mut self) -> Self {
        self.command_timeout = None;
        self
    }

    pub fn with_server_action_csrf_token(mut self, token: impl Into<String>) -> Self {
        self.server_action_csrf_token = Some(token.into());
        self
    }

    pub fn with_server_action_replay_nonce(mut self, nonce: impl Into<String>) -> Self {
        self.server_action_replay_nonce = Some(nonce.into());
        self
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
        let render_options_json = self.render_options_json()?;
        let mut command = self.node_command();
        command
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .arg(render_options_json);
        let output = self.run_command(command)?;

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
        let render_options_json = self.render_options_json()?;
        let mut command = self.node_command();
        command
            .arg("--stream")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .arg(render_options_json);
        let output = self.run_command(command)?;

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
        let render_options_json = self.render_options_json()?;
        let mut command = self.node_command();
        command
            .arg("--server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .arg(render_options_json);
        let output = self.run_command(command)?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        Ok(ferrite_ssr::render_server_payload_json_to_parts(&json)?)
    }

    pub fn render_page_to_server_payload_json(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
    ) -> Result<String> {
        self.render_page_to_server_payload_json_with_conventions(
            page_file,
            layouts,
            params,
            &RouteConventions::default(),
        )
    }

    pub fn render_page_to_server_payload_json_with_conventions(
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
        let render_options_json = self.render_options_json()?;
        let mut command = self.node_command();
        command
            .arg("--server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .arg(render_options_json);
        let output = self.run_command(command)?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout).into_owned();
        ferrite_ssr::render_server_payload_json_to_parts(&json)?;
        Ok(json)
    }

    pub fn invoke_server_action(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
        conventions: &RouteConventions,
        request: &ServerActionRequest,
    ) -> Result<ServerActionResponse> {
        ferrite_protocol::validate_server_action_request(request)?;
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let request_json = serde_json::to_string(request)?;
        let mut command = self.node_command();
        command
            .arg("--server-action")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .arg(request_json);
        let output = self.run_command(command)?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let response: ServerActionResponse = serde_json::from_slice(&output.stdout)?;
        ferrite_protocol::validate_server_action_response(&response)?;
        Ok(response)
    }

    pub fn collect_server_actions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
        conventions: &RouteConventions,
    ) -> Result<ServerActionManifest> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let mut command = self.node_command();
        command
            .arg("--server-action-manifest")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json);
        let output = self.run_command(command)?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let manifest: ServerActionManifest = serde_json::from_slice(&output.stdout)?;
        for action in &manifest.actions {
            ferrite_protocol::validate_server_action_reference_payload(action)?;
        }
        Ok(manifest)
    }

    pub fn generate_static_params(&self, page_file: &Path) -> Result<StaticParamsResult> {
        let mut command = self.node_command();
        command.arg("--static-params").arg(page_file);
        let output = self.run_command(command)?;

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
        let mut command = self.node_command();
        command
            .arg("--metadata")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json);
        let output = self.run_command(command)?;

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
        let mut command = self.node_command();
        command
            .arg("--document")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json);
        let output = self.run_command(command)?;

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
        let mut command = self.node_command();
        command
            .arg("--document-stream")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json);
        let output = self.run_command(command)?;

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
        let mut command = self.node_command();
        command
            .arg("--document-server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json);
        let output = self.run_command(command)?;

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

    pub fn render_document_to_server_payload_json(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
    ) -> Result<String> {
        self.render_document_to_server_payload_json_with_conventions(
            page_file,
            layouts,
            document_file,
            params,
            options,
            &RouteConventions::default(),
        )
    }

    pub fn render_document_to_server_payload_json_with_conventions(
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
        let mut command = self.node_command();
        command
            .arg("--document-server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json);
        let output = self.run_command(command)?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout).into_owned();
        ferrite_ssr::render_server_payload_json_to_parts(&json)?;
        Ok(json)
    }

    fn render_options_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&PageRenderOptions {
            server_action_csrf_token: self.server_action_csrf_token.as_deref(),
            server_action_replay_nonce: self.server_action_replay_nonce.as_deref(),
        })?)
    }

    fn node_command(&self) -> Command {
        let mut command = Command::new("node");
        command.arg(&self.script);
        if self.prebuilt_artifact {
            command.arg(if self.prebuilt_module_source.is_some() {
                "--prebuilt-stdin"
            } else {
                "--prebuilt"
            });
        }
        command.current_dir(&self.project);
        command
    }

    fn run_command(&self, command: Command) -> Result<RendererOutput> {
        let stdin = self.prebuilt_module_source.clone();
        match self.command_timeout {
            Some(timeout) => {
                run_command_with_timeout(command, timeout, stdin, self.cancellation_flag.as_deref())
            }
            None => run_command_to_output(command, stdin, self.cancellation_flag.as_deref()),
        }
    }
}

#[derive(Debug)]
struct RendererOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_command_to_output(
    command: Command,
    stdin: Option<Arc<[u8]>>,
    cancellation_flag: Option<&AtomicBool>,
) -> Result<RendererOutput> {
    run_command_with_limits(
        command,
        None,
        stdin,
        MAX_RENDER_COMMAND_OUTPUT_BYTES,
        cancellation_flag,
    )
}

fn run_command_with_timeout(
    command: Command,
    timeout: Duration,
    stdin: Option<Arc<[u8]>>,
    cancellation_flag: Option<&AtomicBool>,
) -> Result<RendererOutput> {
    run_command_with_limits(
        command,
        Some(timeout),
        stdin,
        MAX_RENDER_COMMAND_OUTPUT_BYTES,
        cancellation_flag,
    )
}

fn run_command_with_limits(
    mut command: Command,
    timeout: Option<Duration>,
    stdin: Option<Arc<[u8]>>,
    max_output_bytes: usize,
    cancellation_flag: Option<&AtomicBool>,
) -> Result<RendererOutput> {
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(command)?;
    let stdin_writer = stdin.map(|input| {
        let mut child_stdin = child.take_stdin().expect("renderer stdin was piped");
        thread::spawn(move || child_stdin.write_all(&input))
    });
    let stdout = child.take_stdout().expect("renderer stdout was piped");
    let stderr = child.take_stderr().expect("renderer stderr was piped");
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_capped_reader(stdout, max_output_bytes, Arc::clone(&output_exceeded));
    let stderr_reader = spawn_capped_reader(stderr, max_output_bytes, Arc::clone(&output_exceeded));
    let started = Instant::now();

    loop {
        if cancellation_flag.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            terminate_process_tree(&mut child);
            if let Some(stdin_writer) = stdin_writer {
                let _ = stdin_writer.join();
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(PageRenderError::Cancelled);
        }

        if output_exceeded.load(Ordering::Acquire) {
            terminate_process_tree(&mut child);
            if let Some(stdin_writer) = stdin_writer {
                let _ = stdin_writer.join();
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(PageRenderError::OutputLimitExceeded {
                limit: max_output_bytes,
            });
        }

        if let Some(status) = child.try_wait()? {
            terminate_process_tree(&mut child);
            if let Some(stdin_writer) = stdin_writer {
                stdin_writer
                    .join()
                    .expect("renderer stdin writer panicked")?;
            }
            let stdout = stdout_reader
                .join()
                .expect("renderer stdout reader panicked")?;
            let stderr = stderr_reader
                .join()
                .expect("renderer stderr reader panicked")?;
            if output_exceeded.load(Ordering::Acquire) {
                return Err(PageRenderError::OutputLimitExceeded {
                    limit: max_output_bytes,
                });
            }
            return Ok(RendererOutput {
                status,
                stdout,
                stderr,
            });
        }

        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            let timeout = timeout.expect("timeout was checked as present");
            terminate_process_tree(&mut child);
            if let Some(stdin_writer) = stdin_writer {
                let _ = stdin_writer.join();
            }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(PageRenderError::TimedOut { timeout });
        }

        let sleep_for = timeout
            .map(|timeout| {
                RENDER_TIMEOUT_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed()))
            })
            .unwrap_or(RENDER_TIMEOUT_POLL_INTERVAL);
        thread::sleep(sleep_for);
    }
}

fn spawn_capped_reader<R: Read + Send + 'static>(
    mut reader: R,
    max_output_bytes: usize,
    output_exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::with_capacity(max_output_bytes.min(64 * 1024));
        let mut buffer = [0_u8; 8192];
        loop {
            let bytes_read = reader.read(&mut buffer)?;
            if bytes_read == 0 {
                return Ok(output);
            }
            let remaining = max_output_bytes.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..bytes_read.min(remaining)]);
            if bytes_read > remaining {
                output_exceeded.store(true, Ordering::Release);
            }
        }
    })
}

struct OwnedChild {
    #[cfg(not(windows))]
    inner: Child,
    #[cfg(windows)]
    inner: Box<dyn StdChildWrapper>,
    armed: bool,
}

impl OwnedChild {
    fn spawn(command: Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        let mut command = {
            let mut command = command;
            command.process_group(0);
            command
        };
        #[cfg(all(not(unix), not(windows)))]
        let mut command = command;

        #[cfg(windows)]
        {
            let mut command = StdCommandWrap::from(command);
            command.wrap(JobObject);
            return Ok(Self {
                inner: command.spawn()?,
                armed: true,
            });
        }

        #[cfg(not(windows))]
        Ok(Self {
            inner: command.spawn()?,
            armed: true,
        })
    }

    fn take_stdin(&mut self) -> Option<ChildStdin> {
        #[cfg(windows)]
        return self.inner.stdin().take();

        #[cfg(not(windows))]
        self.inner.stdin.take()
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        #[cfg(windows)]
        return self.inner.stdout().take();

        #[cfg(not(windows))]
        self.inner.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        #[cfg(windows)]
        return self.inner.stderr().take();

        #[cfg(not(windows))]
        self.inner.stderr.take()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }

    fn terminate(&mut self) {
        if !self.armed {
            return;
        }

        #[cfg(unix)]
        if let Ok(process_group) = i32::try_from(self.inner.id()) {
            // SAFETY: the child was spawned as the leader of a new process group.
            unsafe {
                libc::kill(-process_group, libc::SIGKILL);
            }
        }

        #[cfg(windows)]
        let _ = self.inner.start_kill();
        #[cfg(not(windows))]
        let _ = self.inner.kill();
        let _ = self.inner.wait();
        self.armed = false;
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn terminate_process_tree(child: &mut OwnedChild) {
    child.terminate();
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StaticParamsResult {
    pub has_generate_static_params: bool,
    pub params: Vec<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionManifest {
    pub route_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<ServerActionReferencePayload>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_action_csrf_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_action_replay_nonce: Option<String>,
    pub metadata: PageMetadata,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preload_scripts: Vec<String>,
    pub styles: Vec<String>,
    pub scripts: Vec<String>,
    pub default_title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageRenderOptions<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    server_action_csrf_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_action_replay_nonce: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct PageProps {
    params: BTreeMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_protocol::{
        SERVER_ACTION_REQUEST_MARKER, SERVER_ACTION_REQUEST_VERSION, ServerActionFormValue,
        ServerActionRequest, ServerActionResponseOutcome,
    };
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
    fn passes_server_action_csrf_token_to_page_render_options() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const options = JSON.parse(process.argv[6]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "span",
  props: {},
  children: [{ kind: "text", value: options.serverActionCsrfToken }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script)
            .with_server_action_csrf_token("csrf-token-123");

        let html = renderer.render_page_to_html(&page, &[], &[]).unwrap();

        assert_eq!(html, "<span>csrf-token-123</span>");
    }

    #[test]
    fn passes_server_action_replay_nonce_to_page_render_options() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const options = JSON.parse(process.argv[6]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "span",
  props: {},
  children: [{ kind: "text", value: options.serverActionReplayNonce }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script)
            .with_server_action_replay_nonce("nonce-123");

        let html = renderer.render_page_to_html(&page, &[], &[]).unwrap();

        assert_eq!(html, "<span>nonce-123</span>");
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
    fn renders_page_server_payload_json() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
process.stdout.write(JSON.stringify({
  ferrite: "server-payload",
  version: 1,
  shell: [2, "main", {}, [[0, `Payload ${props.params.id}`]]],
  clientReferences: [],
  chunks: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let payload = renderer
            .render_page_to_server_payload_json(&page, &[], &[("id".to_owned(), json!("raw"))])
            .unwrap();

        assert!(payload.contains(r#""ferrite":"server-payload""#));
        assert!(payload.contains("Payload raw"));
    }

    #[test]
    fn invokes_server_action() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
const layouts = JSON.parse(process.argv[5]);
const conventions = JSON.parse(process.argv[6]);
const request = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  ferrite: "server-action-response",
  version: 1,
  status: "ok",
  data: {
    id: request.id,
    routePath: request.routePath,
    title: request.form.title,
    paramsId: props.params.id,
    layoutCount: layouts.length,
    hasLoading: conventions.loading.endsWith("loading.tsx")
  }
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let layout = temp.path().join("layout.tsx");
        let loading = temp.path().join("loading.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&layout, "").unwrap();
        fs::write(&loading, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);
        let request = ServerActionRequest {
            ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
            version: SERVER_ACTION_REQUEST_VERSION,
            id: "app/posts/[id]/page.tsx#savePost".to_owned(),
            route_path: "/posts/abc".to_owned(),
            form: BTreeMap::from([(
                "title".to_owned(),
                ServerActionFormValue::String("Hello".to_owned()),
            )]),
        };

        let response = renderer
            .invoke_server_action(
                &page,
                &[layout],
                &[("id".to_owned(), json!("abc"))],
                &RouteConventions {
                    loading: Some(loading),
                    error: None,
                },
                &request,
            )
            .unwrap();

        assert_eq!(
            response.outcome,
            ServerActionResponseOutcome::Ok {
                data: json!({
                    "id": "app/posts/[id]/page.tsx#savePost",
                    "routePath": "/posts/abc",
                    "title": "Hello",
                    "paramsId": "abc",
                    "layoutCount": 1,
                    "hasLoading": true
                })
            }
        );
    }

    #[test]
    fn reports_unknown_server_action_ids_without_side_effects() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        let side_effect = temp.path().join("side-effect.txt");
        make_script(
            &script,
            &format!(
                r##"
const request = JSON.parse(process.argv[7]);
if (request.id.includes("#missing")) {{
  console.error(`Ferrite server action "${{request.id}}" was not registered during route render.`);
  process.exit(1);
}}
await import("node:fs/promises").then((fs) => fs.writeFile({}, "ran"));
process.stdout.write(JSON.stringify({{
  ferrite: "server-action-response",
  version: 1,
  status: "ok",
  data: null
}}));
"##,
                serde_json::to_string(&side_effect).unwrap()
            ),
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);
        let request = ServerActionRequest {
            ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
            version: SERVER_ACTION_REQUEST_VERSION,
            id: "app/posts/[id]/page.tsx#missing".to_owned(),
            route_path: "/posts/abc".to_owned(),
            form: BTreeMap::new(),
        };

        let error = renderer
            .invoke_server_action(
                &page,
                &[],
                &[("id".to_owned(), json!("abc"))],
                &RouteConventions::default(),
                &request,
            )
            .unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::NodeFailed { stderr, .. }
                if stderr.contains("was not registered during route render")
        ));
        assert!(!side_effect.exists());
    }

    #[test]
    fn returns_server_action_error_responses() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  ferrite: "server-action-response",
  version: 1,
  status: "error",
  message: "Action exploded"
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);
        let request = ServerActionRequest {
            ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
            version: SERVER_ACTION_REQUEST_VERSION,
            id: "app/posts/[id]/page.tsx#savePost".to_owned(),
            route_path: "/posts/abc".to_owned(),
            form: BTreeMap::new(),
        };

        let response = renderer
            .invoke_server_action(
                &page,
                &[],
                &[("id".to_owned(), json!("abc"))],
                &RouteConventions::default(),
                &request,
            )
            .unwrap();

        assert_eq!(
            response.outcome,
            ServerActionResponseOutcome::Error {
                code: None,
                message: "Action exploded".to_owned()
            }
        );
    }

    #[test]
    fn collects_server_action_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
const layouts = JSON.parse(process.argv[5]);
process.stdout.write(JSON.stringify({
  routePath: `/posts/${props.params.id}`,
  routePattern: "/posts/[id]",
  actions: [{
    ferrite: "server-action-reference",
    version: 1,
    id: "app/posts/[id]/page.tsx#savePost",
    routePattern: "/posts/[id]",
    url: "/_ferrite/action",
    bound: { layoutCount: layouts.length }
  }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let layout = temp.path().join("layout.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&layout, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let manifest = renderer
            .collect_server_actions(
                &page,
                &[layout],
                &[("id".to_owned(), json!("alpha"))],
                &RouteConventions::default(),
            )
            .unwrap();

        assert_eq!(manifest.route_path, "/posts/alpha");
        assert_eq!(manifest.route_pattern.as_deref(), Some("/posts/[id]"));
        assert_eq!(manifest.actions.len(), 1);
        assert_eq!(manifest.actions[0].id, "app/posts/[id]/page.tsx#savePost");
        assert_eq!(manifest.actions[0].url, "/_ferrite/action");
        assert_eq!(
            manifest.actions[0].bound.get("layoutCount"),
            Some(&json!(1))
        );
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
    fn times_out_hanging_node_renders() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
setInterval(() => {}, 1000);
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let timeout = Duration::from_millis(20);
        let renderer =
            PageRenderer::new(temp.path().to_path_buf(), script).with_command_timeout(timeout);
        let started = Instant::now();

        let error = renderer.render_page_to_html(&page, &[], &[]).unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            matches!(error, PageRenderError::TimedOut { timeout: actual } if actual == timeout)
        );
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_renderer_descendants_with_inherited_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
setInterval(() => {{}}, 1000);
"#
            ),
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let timeout = Duration::from_millis(500);
        let renderer =
            PageRenderer::new(temp.path().to_path_buf(), script).with_command_timeout(timeout);
        let started = Instant::now();

        let error = renderer.render_page_to_html(&page, &[], &[]).unwrap_err();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            matches!(error, PageRenderError::TimedOut { timeout: actual } if actual == timeout)
        );
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[cfg(unix)]
    #[test]
    fn successful_renderer_cleans_descendants_before_collecting_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
descendant.unref();
process.stdout.write(JSON.stringify({{ kind: "text", value: "complete" }}));
"#
            ),
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);
        let started = Instant::now();

        let html = renderer.render_page_to_html(&page, &[], &[]).unwrap();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert_eq!(html, "complete");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_renderer_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
setInterval(() => {{}}, 1000);
"#
            ),
        );
        let cancellation_flag = Arc::new(AtomicBool::new(false));
        let cancellation_writer = Arc::clone(&cancellation_flag);
        let pid_path = descendant_pid.clone();
        let cancellation_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !pid_path.is_file() {
                assert!(
                    Instant::now() < deadline,
                    "renderer descendant did not start"
                );
                thread::sleep(Duration::from_millis(5));
            }
            cancellation_writer.store(true, Ordering::Release);
        });
        let mut command = Command::new("node");
        command.arg(script).current_dir(temp.path());
        let started = Instant::now();

        let error =
            run_command_with_limits(command, None, None, 1024, Some(cancellation_flag.as_ref()))
                .unwrap_err();
        cancellation_thread.join().unwrap();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(matches!(error, PageRenderError::Cancelled));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[test]
    fn renderer_output_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(&script, "process.stdout.write('x'.repeat(65));\n");
        let mut command = Command::new("node");
        command.arg(script).current_dir(temp.path());

        let error = run_command_with_limits(command, None, None, 64, None).unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::OutputLimitExceeded { limit: 64 }
        ));
    }

    #[cfg(unix)]
    struct DescendantGuard(Option<i32>);

    #[cfg(unix)]
    impl Drop for DescendantGuard {
        fn drop(&mut self) {
            if let Some(pid) = self.0 {
                // SAFETY: this test records the PID of the child process it spawned.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid: i32, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            // SAFETY: signal 0 checks the recorded child PID without modifying it.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
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
      children: [
        { kind: "element", tag: "title", props: {}, children: [{ kind: "text", value: options.metadata.title }] },
        ...options.preloadScripts.map((href) => ({ kind: "element", tag: "link", props: { rel: "modulepreload", href }, children: [] }))
      ]
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
                    server_action_csrf_token: None,
                    server_action_replay_nonce: None,
                    metadata: PageMetadata {
                        title: Some("Docs".to_owned()),
                        description: None,
                        ..PageMetadata::default()
                    },
                    preload_scripts: vec!["/route.js".to_owned()],
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap();

        assert_eq!(
            html,
            "<!doctype html>\n<html data-route=\"/docs/guide/intro\"><head><title>Docs</title><link href=\"/route.js\" rel=\"modulepreload\"></head><body><div id=\"ferrite-root\">guide/intro</div></body></html>"
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
                    server_action_csrf_token: None,
                    server_action_replay_nonce: None,
                    metadata: PageMetadata {
                        title: Some("Docs".to_owned()),
                        description: None,
                        ..PageMetadata::default()
                    },
                    preload_scripts: vec![],
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
                    server_action_csrf_token: None,
                    server_action_replay_nonce: None,
                    metadata: PageMetadata::default(),
                    preload_scripts: vec![],
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
    fn renders_document_server_payload_json() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const options = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  ferrite: "server-payload",
  version: 1,
  shell: [2, "html", {}, [[2, "body", {}, [[2, "div", { id: options.rootId }, [[0, "Raw document payload"]]]]]]],
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

        let payload = renderer
            .render_document_to_server_payload_json(
                &page,
                &[],
                &document,
                &[],
                &DocumentRenderOptions {
                    root_id: "ferrite-root".to_owned(),
                    route_path: "/".to_owned(),
                    route_pattern: None,
                    build_id: None,
                    server_action_csrf_token: None,
                    server_action_replay_nonce: None,
                    metadata: PageMetadata::default(),
                    preload_scripts: vec![],
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap();

        assert!(payload.contains(r#""ferrite":"server-payload""#));
        assert!(payload.contains("Raw document payload"));
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
                    server_action_csrf_token: None,
                    server_action_replay_nonce: None,
                    metadata: PageMetadata::default(),
                    preload_scripts: vec![],
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
