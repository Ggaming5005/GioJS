//! giojs-server/src/logging.rs
//!
//! Log output: human-readable text (the default) or JSON lines for log
//! shippers (Loki, Datadog, CloudWatch), chosen by `GIO_LOG_FORMAT` or
//! gio.toml `[logging] format` - the environment wins, so one build can log
//! text locally and JSON in the container.
//!
//! JSON lines use the Node worker's shape (logger.ts) - `ts` (RFC 3339 UTC),
//! lowercase `level`, `msg` - plus `target`, so one parser reads both
//! processes. Span fields are flattened into every line: the request span's
//! `request_id` (client_identity.rs) is a top-level key on every line logged
//! while handling that request, exactly like the worker's `requestId`.

use std::fmt;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::format::{JsonFields, Writer};
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormattedFields};
use tracing_subscriber::registry::LookupSpan;

use crate::config::LogFormat;

/// Environment override for `[logging] format`.
pub const LOG_FORMAT_ENV: &str = "GIO_LOG_FORMAT";

/// The effective format: a valid `GIO_LOG_FORMAT` wins over gio.toml. An
/// invalid value falls back to the configured format and returns the warning
/// to log once logging is up.
pub fn resolve_format(
    env_value: Option<&str>,
    configured: LogFormat,
) -> (LogFormat, Option<String>) {
    match env_value.map(str::trim) {
        None | Some("") => (configured, None),
        Some(value) if value.eq_ignore_ascii_case("json") => (LogFormat::Json, None),
        Some(value) if value.eq_ignore_ascii_case("text") => (LogFormat::Text, None),
        Some(value) => (
            configured,
            Some(format!(
                "ignoring {LOG_FORMAT_ENV}={value:?}: expected \"json\" or \"text\""
            )),
        ),
    }
}

/// Install the global subscriber. Returns a warning about the environment
/// override to log now that logging works, if it was invalid.
pub fn init(configured: LogFormat) -> Option<String> {
    let (format, warning) =
        resolve_format(std::env::var(LOG_FORMAT_ENV).ok().as_deref(), configured);
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into());
    match format {
        LogFormat::Text => tracing_subscriber::fmt().with_env_filter(filter).init(),
        LogFormat::Json => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .fmt_fields(JsonFields::new())
            .event_format(JsonLines)
            .init(),
    }
    warning
}

/// One JSON object per event, span fields flattened (see the module docs).
/// Span fields are recorded by `JsonFields`, so each span's stored fields
/// are already a JSON object to merge.
pub struct JsonLines;

/// Top-level keys every line carries; event or span fields with these names
/// are written as `field.<name>` instead of overwriting them.
const RESERVED_KEYS: [&str; 4] = ["ts", "level", "msg", "target"];

impl<S> FormatEvent<S, JsonFields> for JsonLines
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, JsonFields>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut fields = Map::new();
        // Outermost span first, so an inner span's field wins, and the
        // event's own fields win over both.
        if let Some(scope) = ctx.event_scope() {
            for span in scope.from_root() {
                let extensions = span.extensions();
                let Some(stored) = extensions.get::<FormattedFields<JsonFields>>() else {
                    continue;
                };
                if let Ok(Value::Object(span_fields)) = serde_json::from_str(stored.as_str()) {
                    fields.extend(span_fields);
                }
            }
        }
        event.record(&mut JsonVisitor(&mut fields));
        let msg = match fields.remove("message") {
            Some(Value::String(message)) => message,
            Some(other) => other.to_string(),
            None => String::new(),
        };

        let mut ts = String::with_capacity(32);
        SystemTime.format_time(&mut Writer::new(&mut ts))?;
        let metadata = event.metadata();

        let mut out = String::with_capacity(256);
        out.push('{');
        push_pair(&mut out, "ts", &Value::String(ts));
        push_pair(
            &mut out,
            "level",
            &Value::String(level_name(metadata.level()).into()),
        );
        push_pair(&mut out, "msg", &Value::String(msg));
        push_pair(&mut out, "target", &Value::String(metadata.target().into()));
        for (key, value) in &fields {
            if RESERVED_KEYS.contains(&key.as_str()) {
                push_pair(&mut out, &format!("field.{key}"), value);
            } else {
                push_pair(&mut out, key, value);
            }
        }
        out.push('}');
        writeln!(writer, "{out}")
    }
}

/// Append `"key":value` to a JSON object under construction.
fn push_pair(out: &mut String, key: &str, value: &Value) {
    if !out.ends_with('{') {
        out.push(',');
    }
    out.push_str(&Value::String(key.to_string()).to_string());
    out.push(':');
    out.push_str(&value.to_string());
}

fn level_name(level: &Level) -> &'static str {
    match *level {
        Level::TRACE => "trace",
        Level::DEBUG => "debug",
        Level::INFO => "info",
        Level::WARN => "warn",
        Level::ERROR => "error",
    }
}

/// Records an event's fields as JSON values: numbers and booleans stay
/// typed, everything else (`%display`, `?debug`) becomes a string.
struct JsonVisitor<'a>(&'a mut Map<String, Value>);

impl Visit for JsonVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0
            .insert(field.name().into(), Value::String(format!("{value:?}")));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().into(), Value::String(value.into()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), Value::Bool(value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.0
            .insert(field.name().into(), Value::String(value.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing::{error, info, warn};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn json_lines(filter: &str, emit: impl FnOnce()) -> Vec<Value> {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .fmt_fields(JsonFields::new())
            .event_format(JsonLines)
            .finish();
        tracing::subscriber::with_default(subscriber, emit);
        let bytes = capture.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}")))
            .collect()
    }

    #[test]
    fn lines_carry_the_node_logger_keys_and_typed_fields() {
        let lines = json_lines("info", || {
            info!(status = 200u64, cached = true, path = %"/posts/1", "request completed");
        });
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line["level"], "info");
        assert_eq!(line["msg"], "request completed");
        assert_eq!(line["status"], 200);
        assert_eq!(line["cached"], true);
        assert_eq!(line["path"], "/posts/1");
        assert!(line["target"].as_str().unwrap().starts_with("giojs_server"));
        // RFC 3339, UTC.
        let ts = line["ts"].as_str().unwrap();
        assert!(ts.ends_with('Z') && ts.contains('T'), "{ts}");
        assert_eq!(&ts[4..5], "-");
    }

    #[test]
    fn span_fields_are_flattened_into_every_line() {
        // Production often runs RUST_LOG=warn: the error-level request span
        // must still contribute its id.
        let lines = json_lines("warn", || {
            let _request = tracing::error_span!("request", request_id = %"rid-7").entered();
            warn!("rate limit exceeded");
            let _inner = tracing::error_span!("inner", stage = "render").entered();
            error!(request_id = "event-wins", "IPC error");
        });
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["request_id"], "rid-7");
        assert_eq!(lines[0]["msg"], "rate limit exceeded");
        assert_eq!(lines[1]["stage"], "render");
        assert_eq!(lines[1]["request_id"], "event-wins");
        assert_eq!(lines[1]["level"], "error");
    }

    #[test]
    fn fields_named_like_reserved_keys_do_not_clobber_them() {
        let lines = json_lines("info", || {
            info!(level = "custom", msg = "field", "the message");
        });
        assert_eq!(lines[0]["level"], "info");
        assert_eq!(lines[0]["msg"], "the message");
        assert_eq!(lines[0]["field.level"], "custom");
        assert_eq!(lines[0]["field.msg"], "field");
    }

    #[test]
    fn env_override_wins_and_invalid_values_fall_back_with_a_warning() {
        assert_eq!(
            resolve_format(None, LogFormat::Text),
            (LogFormat::Text, None)
        );
        assert_eq!(
            resolve_format(None, LogFormat::Json),
            (LogFormat::Json, None)
        );
        assert_eq!(
            resolve_format(Some(" JSON "), LogFormat::Text).0,
            LogFormat::Json
        );
        assert_eq!(
            resolve_format(Some("text"), LogFormat::Json).0,
            LogFormat::Text
        );
        assert_eq!(
            resolve_format(Some(""), LogFormat::Json),
            (LogFormat::Json, None)
        );
        let (format, warning) = resolve_format(Some("logfmt"), LogFormat::Json);
        assert_eq!(format, LogFormat::Json);
        assert!(warning.unwrap().contains("logfmt"));
    }
}
