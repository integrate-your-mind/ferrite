#[allow(dead_code)]
mod legacy;

pub use legacy::{AttributeValue, CoreError, Element, Node, Result, element, fragment, text};

pub mod observability {
    use std::fmt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde::Serialize;

    pub const EVENT_SCHEMA: &str = "ferrite.observability";
    pub const EVENT_SCHEMA_VERSION: u8 = 1;
    pub const MAX_EVENT_BYTES: usize = 1024;
    pub const MAX_ROUTE_PATTERN_BYTES: usize = 256;
    pub const MAX_CHANNEL_CAPACITY: usize = 1024;
    pub const MAX_DURATION_MS: u64 = 86_400_000;
    pub const MAX_BUILD_ROUTES: u64 = 1_000_000;

    static NEXT_CORRELATION_ID: AtomicU64 = AtomicU64::new(1);
    static CORRELATION_ID_PREFIX: OnceLock<u64> = OnceLock::new();

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Component {
        Builder,
        Server,
        Renderer,
        Navigation,
        Transport,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Operation {
        BuildProject,
        HttpRequest,
        RenderDocument,
        RenderNavigation,
        RenderStream,
        ResponseDelivery,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum EventName {
        OperationStarted,
        OperationCompleted,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Outcome {
        Success,
        Error,
        Cancelled,
        Timeout,
        Disconnected,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ErrorClass {
        InvalidInput,
        NotFound,
        Rejected,
        ResourceExhausted,
        Dependency,
        Protocol,
        StaleInput,
        Io,
        Internal,
        Cancelled,
        Timeout,
        Disconnected,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum FailurePhase {
        Read,
        Render,
        Write,
        Build,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ResponseMode {
        Document,
        PayloadJson,
        PayloadStream,
        Asset,
        Metrics,
        Action,
        Other,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "UPPERCASE")]
    pub enum MethodClass {
        Get,
        Post,
        Head,
        Options,
        Put,
        Patch,
        Delete,
        Other,
    }

    impl MethodClass {
        pub fn from_method(method: &str) -> Self {
            match method {
                "GET" => Self::Get,
                "POST" => Self::Post,
                "HEAD" => Self::Head,
                "OPTIONS" => Self::Options,
                "PUT" => Self::Put,
                "PATCH" => Self::Patch,
                "DELETE" => Self::Delete,
                _ => Self::Other,
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(transparent)]
    pub struct CorrelationId(String);

    impl CorrelationId {
        pub fn generate() -> Self {
            let sequence = NEXT_CORRELATION_ID.fetch_add(1, Ordering::Relaxed);
            let prefix = *CORRELATION_ID_PREFIX.get_or_init(|| {
                let started = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let folded = (started as u64) ^ ((started >> 64) as u64);
                folded ^ u64::from(std::process::id()).rotate_left(32)
            });
            Self(format!("{prefix:016x}{sequence:016x}"))
        }

        pub fn as_str(&self) -> &str {
            &self.0
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(transparent)]
    pub struct RoutePattern(String);

    impl RoutePattern {
        pub fn new(pattern: Option<&str>) -> Self {
            let pattern = pattern.unwrap_or("[unmatched]");
            let mut output = String::with_capacity(pattern.len().min(MAX_ROUTE_PATTERN_BYTES));
            for character in pattern.chars() {
                let character = if character.is_control() {
                    '?'
                } else {
                    character
                };
                if output.len() + character.len_utf8() > MAX_ROUTE_PATTERN_BYTES {
                    break;
                }
                output.push(character);
            }
            if output.is_empty() {
                output.push_str("[unmatched]");
            }
            Self(output)
        }

        pub fn as_str(&self) -> &str {
            &self.0
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct HttpFields {
        pub method: MethodClass,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub status: Option<u16>,
        pub route_pattern: RoutePattern,
        pub response_mode: ResponseMode,
    }

    impl HttpFields {
        pub fn new(
            method: MethodClass,
            status: Option<u16>,
            route_pattern: Option<&str>,
            response_mode: ResponseMode,
        ) -> Self {
            Self {
                method,
                status: status.filter(|status| (100..=599).contains(status)),
                route_pattern: RoutePattern::new(route_pattern),
                response_mode,
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct BuildFields {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub routes: Option<u64>,
    }

    impl BuildFields {
        pub fn new(routes: Option<usize>) -> Self {
            Self {
                routes: routes.map(|routes| {
                    u64::try_from(routes)
                        .unwrap_or(u64::MAX)
                        .min(MAX_BUILD_ROUTES)
                }),
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct Event {
        pub schema: &'static str,
        pub version: u8,
        pub event: EventName,
        pub emitted_at_unix_ms: u64,
        pub correlation_id: CorrelationId,
        pub sequence: u16,
        pub component: Component,
        pub operation: Operation,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub outcome: Option<Outcome>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error_class: Option<ErrorClass>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub failure_phase: Option<FailurePhase>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub http: Option<HttpFields>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub build: Option<BuildFields>,
    }

    impl Event {
        pub fn started(
            correlation_id: CorrelationId,
            sequence: u16,
            component: Component,
            operation: Operation,
        ) -> Self {
            Self {
                schema: EVENT_SCHEMA,
                version: EVENT_SCHEMA_VERSION,
                event: EventName::OperationStarted,
                emitted_at_unix_ms: unix_millis(),
                correlation_id,
                sequence,
                component,
                operation,
                outcome: None,
                error_class: None,
                failure_phase: None,
                duration_ms: None,
                http: None,
                build: None,
            }
        }

        #[allow(clippy::too_many_arguments)]
        pub fn completed(
            correlation_id: CorrelationId,
            sequence: u16,
            component: Component,
            operation: Operation,
            outcome: Outcome,
            error_class: Option<ErrorClass>,
            failure_phase: Option<FailurePhase>,
            duration: Duration,
        ) -> Self {
            let (error_class, failure_phase) = match outcome {
                Outcome::Success => (None, None),
                Outcome::Cancelled => (
                    Some(error_class.unwrap_or(ErrorClass::Cancelled)),
                    failure_phase,
                ),
                Outcome::Timeout => (
                    Some(error_class.unwrap_or(ErrorClass::Timeout)),
                    failure_phase,
                ),
                Outcome::Disconnected => (
                    Some(error_class.unwrap_or(ErrorClass::Disconnected)),
                    failure_phase,
                ),
                Outcome::Error => (
                    Some(error_class.unwrap_or(ErrorClass::Internal)),
                    failure_phase,
                ),
            };
            Self {
                schema: EVENT_SCHEMA,
                version: EVENT_SCHEMA_VERSION,
                event: EventName::OperationCompleted,
                emitted_at_unix_ms: unix_millis(),
                correlation_id,
                sequence,
                component,
                operation,
                outcome: Some(outcome),
                error_class,
                failure_phase,
                duration_ms: Some(duration_millis(duration)),
                http: None,
                build: None,
            }
        }

        pub fn with_http(mut self, http: HttpFields) -> Self {
            self.http = Some(http);
            self.build = None;
            self
        }

        pub fn with_build(mut self, build: BuildFields) -> Self {
            self.build = Some(build);
            self.http = None;
            self
        }

        pub fn to_json_line(&self) -> std::result::Result<String, EventEncodingError> {
            let line = serde_json::to_string(self).map_err(EventEncodingError::Json)?;
            if line.len() > MAX_EVENT_BYTES {
                return Err(EventEncodingError::SizeLimit {
                    actual: line.len(),
                    limit: MAX_EVENT_BYTES,
                });
            }
            Ok(line)
        }
    }

    fn unix_millis() -> u64 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        u64::try_from(millis).unwrap_or(u64::MAX)
    }

    fn duration_millis(duration: Duration) -> u64 {
        u64::try_from(duration.as_millis())
            .unwrap_or(u64::MAX)
            .min(MAX_DURATION_MS)
    }

    #[derive(Debug)]
    pub enum EventEncodingError {
        Json(serde_json::Error),
        SizeLimit { actual: usize, limit: usize },
    }

    impl fmt::Display for EventEncodingError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::Json(error) => write!(formatter, "{error}"),
                Self::SizeLimit { actual, limit } => {
                    write!(formatter, "event is {actual} bytes; limit is {limit}")
                }
            }
        }
    }

    impl std::error::Error for EventEncodingError {}

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum EmitResult {
        Sent,
        Full,
        Closed,
    }

    #[derive(Debug)]
    struct EventEmitterInner {
        sender: SyncSender<Event>,
        dropped: AtomicU64,
    }

    #[derive(Debug, Clone)]
    pub struct EventEmitter {
        inner: Arc<EventEmitterInner>,
    }

    impl EventEmitter {
        pub fn emit(&self, event: Event) -> EmitResult {
            match self.inner.sender.try_send(event) {
                Ok(()) => EmitResult::Sent,
                Err(TrySendError::Full(_)) => {
                    self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                    EmitResult::Full
                }
                Err(TrySendError::Disconnected(_)) => {
                    self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                    EmitResult::Closed
                }
            }
        }

        pub fn dropped_count(&self) -> u64 {
            self.inner.dropped.load(Ordering::Relaxed)
        }
    }

    pub fn bounded_channel(capacity: usize) -> (EventEmitter, Receiver<Event>) {
        let capacity = capacity.clamp(1, MAX_CHANNEL_CAPACITY);
        let (sender, receiver) = sync_channel(capacity);
        (
            EventEmitter {
                inner: Arc::new(EventEmitterInner {
                    sender,
                    dropped: AtomicU64::new(0),
                }),
            },
            receiver,
        )
    }

    #[cfg(test)]
    mod tests {
        use std::collections::HashSet;

        use super::*;

        fn completed_event(route_pattern: Option<&str>) -> Event {
            Event::completed(
                CorrelationId::generate(),
                1,
                Component::Server,
                Operation::HttpRequest,
                Outcome::Success,
                None,
                None,
                Duration::from_millis(17),
            )
            .with_http(HttpFields::new(
                MethodClass::Get,
                Some(200),
                route_pattern,
                ResponseMode::Document,
            ))
        }

        #[test]
        fn serializes_the_stable_v1_schema() {
            let value: serde_json::Value =
                serde_json::from_str(&completed_event(Some("/posts/[id]")).to_json_line().unwrap())
                    .unwrap();

            assert_eq!(value["schema"], EVENT_SCHEMA);
            assert_eq!(value["version"], EVENT_SCHEMA_VERSION);
            assert_eq!(value["event"], "operation_completed");
            assert_eq!(value["component"], "server");
            assert_eq!(value["operation"], "http_request");
            assert_eq!(value["outcome"], "success");
            assert_eq!(value["duration_ms"], 17);
            assert_eq!(value["http"]["method"], "GET");
            assert_eq!(value["http"]["status"], 200);
            assert_eq!(value["http"]["route_pattern"], "/posts/[id]");
            assert_eq!(value["http"]["response_mode"], "document");
            assert!(value.get("error_class").is_none());
            assert!(value.get("failure_phase").is_none());
        }

        #[test]
        fn correlation_ids_are_fixed_width_hex_and_unique() {
            let first = CorrelationId::generate();
            let second = CorrelationId::generate();

            assert_eq!(first.as_str().len(), 32);
            assert!(first.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_ne!(first, second);
        }

        #[test]
        fn correlation_ids_remain_unique_across_concurrent_emitters() {
            let workers = (0..8)
                .map(|_| {
                    std::thread::spawn(|| {
                        (0..128)
                            .map(|_| CorrelationId::generate().as_str().to_owned())
                            .collect::<Vec<_>>()
                    })
                })
                .collect::<Vec<_>>();
            let ids = workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>();
            let unique = ids.iter().collect::<HashSet<_>>();

            assert_eq!(ids.len(), 1_024);
            assert_eq!(unique.len(), ids.len());
        }

        #[test]
        fn route_patterns_are_control_free_bounded_and_events_fit_the_ceiling() {
            let input = format!("/{}\\nsecret-query-token", "\"".repeat(600));
            let event = completed_event(Some(&input));
            let line = event.to_json_line().unwrap();
            let route = event.http.as_ref().unwrap().route_pattern.as_str();

            assert!(route.len() <= MAX_ROUTE_PATTERN_BYTES);
            assert!(!route.chars().any(char::is_control));
            assert!(!line.contains("secret-query-token"));
            assert!(line.len() <= MAX_EVENT_BYTES);
        }

        #[test]
        fn completed_events_normalize_outcomes_and_caps() {
            let event = Event::completed(
                CorrelationId::generate(),
                2,
                Component::Transport,
                Operation::ResponseDelivery,
                Outcome::Timeout,
                None,
                Some(FailurePhase::Write),
                Duration::from_secs(172_800),
            )
            .with_build(BuildFields::new(Some(usize::MAX)));

            assert_eq!(event.error_class, Some(ErrorClass::Timeout));
            assert_eq!(event.duration_ms, Some(MAX_DURATION_MS));
            assert_eq!(event.build.unwrap().routes, Some(MAX_BUILD_ROUTES));
        }

        #[test]
        fn bounded_emitter_never_waits_and_records_drops() {
            let (emitter, receiver) = bounded_channel(1);
            assert_eq!(
                emitter.emit(completed_event(Some("/first"))),
                EmitResult::Sent
            );
            assert_eq!(
                emitter.emit(completed_event(Some("/second"))),
                EmitResult::Full
            );
            assert_eq!(emitter.dropped_count(), 1);

            drop(receiver);
            assert_eq!(
                emitter.emit(completed_event(Some("/third"))),
                EmitResult::Closed
            );
            assert_eq!(emitter.dropped_count(), 2);
        }
    }
}

pub fn render_to_html(node: &Node) -> Result<String> {
    let mut out = String::new();
    render_node(node, &mut out)?;
    Ok(out)
}

fn render_node(node: &Node, out: &mut String) -> Result<()> {
    match node {
        Node::Text(value) => escape_text(value, out),
        Node::Fragment(children) => {
            for child in children {
                render_node(child, out)?;
            }
        }
        Node::Element(element) => {
            out.push('<');
            out.push_str(element.tag());
            for (name, value) in element.attributes() {
                render_attribute(name, value, out)?;
            }
            out.push('>');
            if !is_void_element(element.tag()) {
                for child in element.children() {
                    render_node(child, out)?;
                }
                out.push_str("</");
                out.push_str(element.tag());
                out.push('>');
            }
        }
    }
    Ok(())
}

fn render_attribute(name: &str, value: &AttributeValue, out: &mut String) -> Result<()> {
    match value {
        AttributeValue::Bool(value) if is_html_boolean_attribute(name) => {
            if *value {
                out.push(' ');
                out.push_str(name);
            }
        }
        AttributeValue::Bool(value) => {
            write_quoted_attribute(name, if *value { "true" } else { "false" }, out)
        }
        AttributeValue::String(value) => write_quoted_attribute(name, value, out),
        AttributeValue::Number(value) => {
            if !value.is_finite() {
                return Err(CoreError::NonFiniteNumberAttribute(name.to_owned()));
            }
            write_quoted_attribute(name, &format_number(*value), out);
        }
    }
    Ok(())
}

fn write_quoted_attribute(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    escape_attribute(value, out);
    out.push('"');
}

fn is_html_boolean_attribute(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "allowfullscreen"
            | "async"
            | "autofocus"
            | "autoplay"
            | "capture"
            | "checked"
            | "controls"
            | "credentialless"
            | "default"
            | "defer"
            | "disabled"
            | "disablepictureinpicture"
            | "disableremoteplayback"
            | "download"
            | "formnovalidate"
            | "hidden"
            | "inert"
            | "ismap"
            | "itemscope"
            | "loop"
            | "multiple"
            | "muted"
            | "nomodule"
            | "novalidate"
            | "open"
            | "playsinline"
            | "readonly"
            | "required"
            | "reversed"
            | "scoped"
            | "seamless"
            | "selected"
    )
}

fn escape_text(value: &str, out: &mut String) {
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(char),
        }
    }
}

fn escape_attribute(value: &str, out: &mut String) {
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
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn is_void_element(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_html_boolean_and_string_boolean_attributes() {
        let tree = element(
            "div",
            [
                ("aria-hidden", AttributeValue::from(false)),
                ("data-ready", AttributeValue::from(true)),
                ("draggable", AttributeValue::from(false)),
                ("hidden", AttributeValue::from(false)),
            ],
            vec![],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<div aria-hidden=\"false\" data-ready=\"true\" draggable=\"false\"></div>"
        );
    }

    #[test]
    fn preserves_true_html_boolean_attributes() {
        let tree = element(
            "input",
            [
                ("disabled", AttributeValue::from(true)),
                ("checked", AttributeValue::from(false)),
            ],
            vec![],
        )
        .unwrap();
        assert_eq!(render_to_html(&tree).unwrap(), "<input disabled>");
    }

    #[test]
    fn preserves_overloaded_and_modern_boolean_attribute_semantics() {
        let tree = element(
            "video",
            [
                ("capture", AttributeValue::from(false)),
                ("credentialless", AttributeValue::from(false)),
                ("disablepictureinpicture", AttributeValue::from(true)),
                ("disableremoteplayback", AttributeValue::from(false)),
                ("download", AttributeValue::from("clip.mp4")),
            ],
            vec![],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<video disablepictureinpicture download=\"clip.mp4\"></video>"
        );
    }
}
