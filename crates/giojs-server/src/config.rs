//! giojs-server/src/config.rs
//!
//! gio.toml parsing into typed config structs with serde defaults.
//! A missing file falls back to defaults; a file that exists but cannot be
//! read or parsed is a startup-time failure: print the error and exit(1).

use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("cannot parse {path}: {source}")]
    Parse {
        path: String,
        source: toml::de::Error,
    },
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct MetricsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub ip_allowlist: Vec<String>,
}

/// `[dev]`: settings that only apply when NODE_ENV=development.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct DevConfig {
    /// Extra Host names the /_gio/devtools* endpoints answer to besides
    /// localhost, loopback IPs, and a specific `server.host` (DNS rebinding
    /// protection). A leading `.` or `*.` matches subdomains; entries that
    /// are not a hostname or IP are ignored with a startup warning.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

// app is parsed from gio.toml but consumed by the Node layer, not by Rust server code.
#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
pub struct GioConfig {
    #[serde(default)]
    pub app: AppConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default, rename = "fonts")]
    pub fonts: Vec<FontEntry>,
    #[serde(default)]
    pub images: ImageConfig,
    #[serde(default)]
    pub css: CssConfig,
    #[serde(default)]
    pub websocket: WebsocketConfig,
    #[serde(default, rename = "rate_limits")]
    pub rate_limits: Vec<RateLimitEntry>,
    #[serde(default)]
    pub i18n: I18nConfig,
    #[serde(default)]
    pub metrics: MetricsConfig,
    #[serde(default)]
    pub redirects: Vec<crate::rules::RedirectRule>,
    #[serde(default)]
    pub rewrites: Vec<crate::rules::RewriteRule>,
    #[serde(default)]
    pub headers: Vec<crate::rules::HeaderRule>,
    #[serde(default)]
    pub guards: Vec<crate::rules::GuardRule>,
    #[serde(default)]
    pub dev: DevConfig,
}

impl GioConfig {
    /// The `[[redirects]]` / `[[rewrites]]` / `[[headers]]` / `[[guards]]`
    /// sections bundled into the raw shape `rules::RuleSet::compile` takes.
    pub fn middleware_rules(&self) -> crate::rules::MiddlewareRules {
        crate::rules::MiddlewareRules {
            redirects: self.redirects.clone(),
            rewrites: self.rewrites.clone(),
            headers: self.headers.clone(),
            guards: self.guards.clone(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct I18nConfig {
    #[serde(default)]
    pub locales: Vec<String>,
    #[serde(default = "default_locale")]
    pub default_locale: String,
    #[serde(default = "default_detect_from")]
    pub detect_from: Vec<String>,
}

fn default_locale() -> String {
    "en".to_string()
}
fn default_detect_from() -> Vec<String> {
    vec![
        "path".to_string(),
        "accept-language".to_string(),
        "cookie".to_string(),
    ]
}

impl Default for I18nConfig {
    fn default() -> Self {
        Self {
            locales: Vec::new(),
            default_locale: default_locale(),
            detect_from: default_detect_from(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct RateLimitEntry {
    pub path: String,
    #[serde(default = "default_per_ip")]
    pub per_ip: u64,
    #[serde(default = "default_window_seconds")]
    pub window_seconds: u64,
    #[serde(default = "default_burst")]
    pub burst: u64,
    pub key_header: Option<String>,
}

fn default_per_ip() -> u64 {
    100
}
fn default_window_seconds() -> u64 {
    60
}
fn default_burst() -> u64 {
    20
}

#[derive(Debug, Deserialize, Clone)]
pub struct WebsocketConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_max_connections")]
    pub max_connections: usize,
    #[serde(default = "default_ping_interval")]
    pub ping_interval_secs: u64,
}

fn default_max_connections() -> usize {
    1000
}
fn default_ping_interval() -> u64 {
    30
}

impl Default for WebsocketConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_connections: 1000,
            ping_interval_secs: 30,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct CssConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub minify: bool,
    #[serde(default = "default_true")]
    pub critical_extraction: bool,
}

fn default_true() -> bool {
    true
}

impl Default for CssConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            minify: true,
            critical_extraction: true,
        }
    }
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct RemotePattern {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub hostname: String,
    pub pathname: Option<String>,
}

fn default_protocol() -> String {
    "https".to_string()
}

#[derive(Debug, Deserialize, Clone)]
pub struct ImageConfig {
    #[serde(default = "default_allowed_widths")]
    pub allowed_widths: Vec<u32>,
    #[serde(default = "default_image_quality")]
    pub quality: u8,
    #[serde(default)]
    pub remote_patterns: Vec<RemotePattern>,
    #[serde(default = "default_image_disk_max_bytes")]
    pub disk_max_bytes: u64,
    #[serde(default = "default_image_max_remote_bytes")]
    pub max_remote_bytes: u64,
}

fn default_allowed_widths() -> Vec<u32> {
    vec![
        16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
    ]
}

fn default_image_quality() -> u8 {
    75
}

fn default_image_disk_max_bytes() -> u64 {
    512 * 1024 * 1024
}

fn default_image_max_remote_bytes() -> u64 {
    20 * 1024 * 1024
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            allowed_widths: default_allowed_widths(),
            quality: default_image_quality(),
            remote_patterns: Vec::new(),
            disk_max_bytes: default_image_disk_max_bytes(),
            max_remote_bytes: default_image_max_remote_bytes(),
        }
    }
}

/// Env var the Node worker reads its `[images]` settings from.
pub const WORKER_IMAGE_CONFIG_ENV: &str = "GIO_IMAGE_CONFIG";

/// Worker env vars whose values change the rendered HTML. They are hashed
/// into the derived deployment ID, so a restart with different values never
/// serves persisted pages rendered with the old ones. Never list a secret or
/// a per-boot value here: the ID is public, and must stay stable across
/// restarts of the same build and config.
pub const WORKER_RENDER_SETTINGS_ENV: &[&str] = &[WORKER_IMAGE_CONFIG_ENV];

impl ImageConfig {
    /// The `[images]` settings `<GioImage>` renders with, as JSON for the
    /// worker: srcset candidates must be widths `/_gio/image` accepts (any
    /// other width is a 400), and the default quality matches the
    /// optimizer's. Widths are sorted and deduplicated; 0 is never a usable
    /// candidate.
    pub fn worker_json(&self) -> String {
        let mut widths: Vec<u32> = self
            .allowed_widths
            .iter()
            .copied()
            .filter(|w| *w > 0)
            .collect();
        widths.sort_unstable();
        widths.dedup();
        serde_json::json!({
            "widths": widths,
            "quality": self.quality.clamp(1, 100),
        })
        .to_string()
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct FontEntry {
    pub family: String,
    pub url: String,
    #[serde(default = "default_font_weight")]
    pub weight: u16,
    #[serde(default = "default_font_style")]
    pub style: String,
}

fn default_font_weight() -> u16 {
    400
}
fn default_font_style() -> String {
    "normal".to_string()
}

// Fields parsed from gio.toml for completeness; consumed by the Node layer, not Rust.
#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
pub struct AppConfig {
    pub name: Option<String>,
    pub router: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_http2")]
    pub http2: bool,
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    // Connection-level DoS limits. For every field below, 0 disables the
    // limit/timeout.
    /// Concurrent TCP connections; past it the accept loop stops accepting
    /// (new clients wait in the kernel backlog) until a connection closes.
    #[serde(default = "default_max_connections_server")]
    pub max_connections: usize,
    #[serde(default = "default_tls_handshake_timeout_secs")]
    pub tls_handshake_timeout_secs: u64,
    /// Deadline for receiving a complete request head. Also bounds how long
    /// a fresh connection may wait for its first request (protocol sniffing
    /// and the HTTP/2 handshake included) and, because hyper restarts the
    /// timer while an HTTP/1.1 connection sits idle, its keep-alive idle time.
    #[serde(default = "default_header_read_timeout_secs")]
    pub header_read_timeout_secs: u64,
    /// Deadline for buffering a whole request body; exceeded -> 408.
    #[serde(default = "default_request_body_timeout_secs")]
    pub request_body_timeout_secs: u64,
    /// Close connections with no request in flight for this long (HTTP/2
    /// mainly; HTTP/1.1 idles are usually reaped by header_read_timeout_secs
    /// first). Streaming and SSE responses count as in flight.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_http2_max_concurrent_streams")]
    pub http2_max_concurrent_streams: u32,
    /// HTTP/2 PING cadence; a peer that does not ack within
    /// http2_keep_alive_timeout_secs is dead and its connection is closed.
    #[serde(default = "default_http2_keep_alive_interval_secs")]
    pub http2_keep_alive_interval_secs: u64,
    #[serde(default = "default_http2_keep_alive_timeout_secs")]
    pub http2_keep_alive_timeout_secs: u64,
    #[serde(default)]
    pub tls: TlsConfig,
}

fn default_http2() -> bool {
    true
}

fn default_max_body_bytes() -> usize {
    2 * 1024 * 1024
}

fn default_max_connections_server() -> usize {
    10_000
}
fn default_tls_handshake_timeout_secs() -> u64 {
    10
}
fn default_header_read_timeout_secs() -> u64 {
    10
}
fn default_request_body_timeout_secs() -> u64 {
    30
}
fn default_idle_timeout_secs() -> u64 {
    60
}
fn default_http2_max_concurrent_streams() -> u32 {
    250
}
fn default_http2_keep_alive_interval_secs() -> u64 {
    20
}
fn default_http2_keep_alive_timeout_secs() -> u64 {
    20
}

/// A `*_secs` field as a Duration, with 0 meaning "disabled".
fn secs(value: u64) -> Option<std::time::Duration> {
    (value > 0).then(|| std::time::Duration::from_secs(value))
}

impl ServerConfig {
    pub fn tls_handshake_timeout(&self) -> Option<std::time::Duration> {
        secs(self.tls_handshake_timeout_secs)
    }
    pub fn header_read_timeout(&self) -> Option<std::time::Duration> {
        secs(self.header_read_timeout_secs)
    }
    pub fn request_body_timeout(&self) -> Option<std::time::Duration> {
        secs(self.request_body_timeout_secs)
    }
    pub fn idle_timeout(&self) -> Option<std::time::Duration> {
        secs(self.idle_timeout_secs)
    }
    /// (interval, ack timeout), or None when either is 0: a ping without an
    /// ack deadline reaps nothing.
    pub fn http2_keep_alive(&self) -> Option<(std::time::Duration, std::time::Duration)> {
        secs(self.http2_keep_alive_interval_secs).zip(secs(self.http2_keep_alive_timeout_secs))
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct TlsConfig {
    #[serde(default)]
    pub enabled: bool,
    pub cert_path: Option<String>,
    pub key_path: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 3000,
            http2: true,
            max_body_bytes: default_max_body_bytes(),
            max_connections: default_max_connections_server(),
            tls_handshake_timeout_secs: default_tls_handshake_timeout_secs(),
            header_read_timeout_secs: default_header_read_timeout_secs(),
            request_body_timeout_secs: default_request_body_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            http2_max_concurrent_streams: default_http2_max_concurrent_streams(),
            http2_keep_alive_interval_secs: default_http2_keep_alive_interval_secs(),
            http2_keep_alive_timeout_secs: default_http2_keep_alive_timeout_secs(),
            tls: TlsConfig::default(),
        }
    }
}

impl GioConfig {
    pub fn load() -> Self {
        // GIO_APP_DIR is the `app/` subdirectory; gio.toml lives one level up.
        // Fall back to gio.toml in the process CWD if that path doesn't exist.
        let path = std::env::var("GIO_APP_DIR")
            .ok()
            .and_then(|app_dir| {
                let p = std::path::Path::new(&app_dir).parent()?.join("gio.toml");
                p.exists().then_some(p)
            })
            .unwrap_or_else(|| std::path::PathBuf::from("gio.toml"));

        match Self::load_from_path(&path) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("giojs-server: configuration error: {error}");
                std::process::exit(1);
            }
        }
    }

    fn load_from_path(path: &std::path::Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.display().to_string(),
            source,
        })?;
        toml::from_str(&raw).map_err(|source| ConfigError::Parse {
            path: path.display().to_string(),
            source,
        })
    }

    /// Path to the project root directory (parent of GIO_APP_DIR or CWD).
    pub fn project_root() -> std::path::PathBuf {
        project_root_of(std::env::var("GIO_APP_DIR").ok().as_deref())
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.server.host, self.server.port)
    }
}

/// The parent of `app_dir`, or `.`. A single relative segment
/// (`GIO_APP_DIR=app`) has the empty path as its parent, which
/// canonicalize() and friends reject - it means the CWD.
fn project_root_of(app_dir: Option<&str>) -> std::path::PathBuf {
    app_dir
        .and_then(|app_dir| std::path::Path::new(app_dir).parent())
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn unique_temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("gio_config_test_{}_{name}", std::process::id()))
    }

    #[test]
    fn missing_file_yields_defaults() {
        let path = unique_temp_path("missing.toml");
        let config = GioConfig::load_from_path(&path).unwrap();
        assert_eq!(config.server.host, "0.0.0.0");
        assert_eq!(config.server.port, 3000);
        assert_eq!(config.images.quality, 75);
        assert_eq!(config.images.disk_max_bytes, 512 * 1024 * 1024);
        assert_eq!(config.images.max_remote_bytes, 20 * 1024 * 1024);
    }

    #[test]
    fn image_worker_json_carries_the_optimizer_widths_and_quality() {
        let path = unique_temp_path("images_worker.toml");
        std::fs::write(
            &path,
            "[images]\nallowed_widths = [1200, 640, 0, 828, 640]\nquality = 80\n",
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let json: serde_json::Value =
            serde_json::from_str(&result.unwrap().images.worker_json()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "widths": [640, 828, 1200], "quality": 80 })
        );

        let defaults: serde_json::Value =
            serde_json::from_str(&ImageConfig::default().worker_json()).unwrap();
        assert_eq!(defaults["widths"].as_array().unwrap().len(), 16);
        assert_eq!(defaults["quality"], 75);
    }

    #[test]
    fn valid_file_is_parsed() {
        let path = unique_temp_path("valid.toml");
        std::fs::write(&path, "[server]\nhost = \"127.0.0.1\"\nport = 4321\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let config = result.unwrap();
        assert_eq!(config.server.host, "127.0.0.1");
        assert_eq!(config.server.port, 4321);
    }

    #[test]
    fn connection_limits_default_when_server_section_omits_them() {
        let path = unique_temp_path("conn_defaults.toml");
        std::fs::write(&path, "[server]\nhost = \"127.0.0.1\"\nport = 4321\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let server = result.unwrap().server;
        assert_eq!(server.max_connections, 10_000);
        assert_eq!(
            server.tls_handshake_timeout(),
            Some(Duration::from_secs(10))
        );
        assert_eq!(server.header_read_timeout(), Some(Duration::from_secs(10)));
        assert_eq!(server.request_body_timeout(), Some(Duration::from_secs(30)));
        assert_eq!(server.idle_timeout(), Some(Duration::from_secs(60)));
        assert_eq!(server.http2_max_concurrent_streams, 250);
        assert_eq!(
            server.http2_keep_alive(),
            Some((Duration::from_secs(20), Duration::from_secs(20)))
        );
        // The no-file default must agree with the serde defaults.
        let fallback = ServerConfig::default();
        assert_eq!(fallback.max_connections, server.max_connections);
        assert_eq!(fallback.header_read_timeout(), server.header_read_timeout());
        assert_eq!(fallback.idle_timeout(), server.idle_timeout());
        assert_eq!(fallback.http2_keep_alive(), server.http2_keep_alive());
    }

    #[test]
    fn connection_limits_parse_and_zero_disables() {
        let path = unique_temp_path("conn_limits.toml");
        std::fs::write(
            &path,
            r#"
[server]
host = "127.0.0.1"
port = 4321
max_connections = 64
tls_handshake_timeout_secs = 0
header_read_timeout_secs = 2
request_body_timeout_secs = 0
idle_timeout_secs = 5
http2_max_concurrent_streams = 16
http2_keep_alive_interval_secs = 7
http2_keep_alive_timeout_secs = 0
"#,
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let server = result.unwrap().server;
        assert_eq!(server.max_connections, 64);
        assert_eq!(server.tls_handshake_timeout(), None);
        assert_eq!(server.header_read_timeout(), Some(Duration::from_secs(2)));
        assert_eq!(server.request_body_timeout(), None);
        assert_eq!(server.idle_timeout(), Some(Duration::from_secs(5)));
        assert_eq!(server.http2_max_concurrent_streams, 16);
        assert_eq!(
            server.http2_keep_alive(),
            None,
            "pings without an ack deadline reap nothing, so either 0 disables both"
        );
    }

    #[test]
    fn rule_sections_parse_from_toml() {
        let path = unique_temp_path("rules.toml");
        std::fs::write(
            &path,
            r#"
[[redirects]]
from   = "/moved"
to     = "/cached"
status = 301

[[redirects]]
from = "/blog/:slug"
to   = "/posts/:slug"

[[rewrites]]
from = "/alias"
to   = "/cached"

[[headers]]
path = "/docs/*rest"
[headers.headers]
x-frame-options = "DENY"

[[guards]]
path           = "/admin"
require_cookie = "session"
redirect_to    = "/"
"#,
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let config = result.unwrap();
        assert_eq!(config.redirects.len(), 2);
        assert_eq!(config.redirects[0].status, 301);
        assert_eq!(
            config.redirects[1].status, 302,
            "status must default to 302"
        );
        assert_eq!(config.rewrites.len(), 1);
        assert_eq!(config.headers.len(), 1);
        assert_eq!(
            config.headers[0]
                .headers
                .get("x-frame-options")
                .map(String::as_str),
            Some("DENY")
        );
        assert_eq!(config.guards.len(), 1);
        assert_eq!(config.guards[0].require_cookie, "session");
        let bundle = config.middleware_rules();
        assert_eq!(bundle.redirects.len(), 2);
        assert_eq!(bundle.guards.len(), 1);
    }

    #[test]
    fn missing_rule_sections_default_to_empty() {
        let path = unique_temp_path("no_rules.toml");
        let config = GioConfig::load_from_path(&path).unwrap();
        assert!(config.redirects.is_empty());
        assert!(config.rewrites.is_empty());
        assert!(config.headers.is_empty());
        assert!(config.guards.is_empty());
    }

    #[test]
    fn dev_allowed_hosts_parse_and_default_to_empty() {
        let missing = GioConfig::load_from_path(&unique_temp_path("no_dev.toml")).unwrap();
        assert!(missing.dev.allowed_hosts.is_empty());

        let path = unique_temp_path("dev.toml");
        std::fs::write(
            &path,
            "[dev]\nallowed_hosts = [\"192.168.1.20\", \"myvm.local\"]\n",
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let config = result.unwrap();
        assert_eq!(config.dev.allowed_hosts, vec!["192.168.1.20", "myvm.local"]);
    }

    #[test]
    fn invalid_file_returns_parse_error() {
        let path = unique_temp_path("invalid.toml");
        std::fs::write(&path, "[server\nport = ???").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert!(matches!(result, Err(ConfigError::Parse { .. })));
    }

    #[test]
    fn project_root_is_never_the_empty_path() {
        use std::path::{Path, PathBuf};
        // `GIO_APP_DIR=app` used to yield "", which canonicalize() rejects -
        // the dev watcher then watched nothing at all.
        for app_dir in ["app", "app/"] {
            let root = project_root_of(Some(app_dir));
            assert_eq!(root, PathBuf::from("."), "{app_dir}");
            assert!(std::fs::canonicalize(&root).is_ok());
        }
        assert_eq!(project_root_of(None), PathBuf::from("."));
        assert_eq!(project_root_of(Some("/")), PathBuf::from("."));
        assert_eq!(project_root_of(Some("site/app")), Path::new("site"));
        assert_eq!(
            project_root_of(Some("/srv/site/app")),
            Path::new("/srv/site")
        );
    }
}
