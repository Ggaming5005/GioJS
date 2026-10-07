//! giojs-server/src/config.rs
//!
//! gio.toml parsing into typed config structs with serde defaults.
//! A missing file falls back to defaults; a file that exists but cannot be
//! read or parsed is a startup-time failure: print the error and exit(1).
//! So is a `[[guards]]` entry that would not protect its path - other rules
//! are skipped with a warning, but a skipped guard leaves its path open.
//!
//! Strict: an unknown key anywhere is a startup error naming the key path,
//! the line and the closest valid key (see config_diagnostics.rs), because a
//! misspelled setting that is silently ignored leaves a default in place the
//! author thinks they changed. Every struct below denies unknown fields; the
//! top level is checked against `SECTIONS` instead, so `[x-...]` tables stay
//! free for other tools. Keys earlier releases documented that never did
//! anything are rejected with what to do instead (`RETIRED_KEYS`).
//!
//! The listen address resolves env > gio.toml > default: `GIO_HOST` /
//! `GIO_PORT`, then `PORT` (set by Heroku, Render, Railway, Fly.io, Cloud
//! Run) for the port, then `[server] host` / `port`, then 0.0.0.0:3000.
//!
//! packages/giojs/gio.schema.json is rendered from these types (the
//! cfg(test) JsonSchema derives) and a test fails when it is out of date.

use serde::Deserialize;
use thiserror::Error;

use crate::config_diagnostics;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    /// `location` is `path:line:column` when toml reports a position. Not
    /// toml's own rendering, which quotes the offending line: gio.toml holds
    /// secrets (`[revalidate] token`, `[metrics] token`) and this message
    /// reaches logs and `--check-config` reports - like a .env error, it
    /// carries a position and the reason only.
    #[error("cannot parse {location}: {}", one_line(.source.message()))]
    Parse {
        location: String,
        source: toml::de::Error,
    },
    /// `location` is `path:line`; `hint` starts with " - " when present.
    #[error("{location}: unknown key {key}{hint}")]
    UnknownKey {
        location: String,
        key: String,
        hint: String,
    },
    #[error("{location}: invalid {key}: {message}")]
    InvalidValue {
        location: String,
        key: String,
        message: String,
    },
    #[error("invalid [[guards]] entry for \"{guard}\" in {path}: {source}")]
    InvalidGuard {
        path: String,
        guard: String,
        source: crate::rules::RuleError,
    },
    #[error("invalid {name}={value:?}: {reason}")]
    InvalidEnv {
        name: &'static str,
        value: String,
        reason: &'static str,
    },
}

/// `[metrics]`: the Prometheus endpoint `/_gio/metrics`. Off when the
/// section is absent; a present section turns it on unless `enabled = false`.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MetricsConfig {
    /// Serve `/_gio/metrics`.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Require `Authorization: Bearer <token>` when set.
    #[serde(default)]
    pub token: String,
    /// Only these client IPs or CIDR blocks may scrape (after
    /// `trusted_proxies` resolution).
    #[serde(default)]
    pub ip_allowlist: Vec<String>,
}

/// `[revalidate]`: the on-demand revalidation endpoint (see revalidate.rs).
/// GIO_REVALIDATE_TOKEN overrides `token`; with neither set, the endpoint
/// does not exist. Unknown keys are a startup error: a misspelled token key
/// must not silently leave the endpoint off.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    test,
    schemars(
        description = "`[revalidate]`: POST /_gio/revalidate purges cached pages by tag \
        or path. The endpoint exists only with a token (here or GIO_REVALIDATE_TOKEN, which wins)."
    )
)]
pub struct RevalidateConfig {
    /// Bearer token for `POST /_gio/revalidate`, at least 32 bytes.
    #[serde(default)]
    pub token: String,
}

/// `[dev]`: settings that only apply when NODE_ENV=development.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DevConfig {
    /// Extra Host names the /_gio/devtools* endpoints answer to besides
    /// localhost, loopback IPs, and a specific `server.host` (DNS rebinding
    /// protection). A leading `.` or `*.` matches subdomains; entries that
    /// are not a hostname or IP are ignored with a startup warning.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    /// Glob patterns (relative to the project root) the dev watcher never
    /// restarts for: data files the app writes, such as `["data/**",
    /// "*.db"]`. `*` stays within a path segment, `**` spans segments; a
    /// pattern without `/` matches a name at any depth.
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Vec<String>"))]
    pub watch_ignore: crate::dev_watch::WatchIgnore,
}

/// `[security]`: default response headers, Content-Security-Policy and
/// cross-site request protection (see security.rs). Every key is optional.
/// Unknown keys are a startup error: a misspelled security setting must not
/// silently leave a protection off.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    test,
    schemars(
        description = "`[security]`: default response headers, Content-Security-Policy \
        and cross-site request protection. Every key is optional."
    )
)]
pub struct SecurityConfig {
    /// `[security.headers]`: overrides for the default response headers
    /// (`x-content-type-options`, `x-frame-options`, `referrer-policy`) and
    /// extra headers sent by default (`permissions-policy`,
    /// `cross-origin-opener-policy`, ...). An empty value removes a default.
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// Strict-Transport-Security. Unset: `max-age=31536000` when
    /// `[server.tls]` is enabled, nothing otherwise. `true` / a string / a
    /// table send it on every response (TLS terminated by a proxy); `false`
    /// or `""` never send it.
    #[serde(default)]
    pub hsts: Option<HstsSetting>,
    /// Content-Security-Policy. `{nonce}` is replaced by a fresh random
    /// nonce per response, which every framework inline script carries.
    #[serde(default)]
    pub csp: Option<String>,
    /// Content-Security-Policy-Report-Only, same syntax as `csp`.
    #[serde(default)]
    pub csp_report_only: Option<String>,
    #[serde(default)]
    pub csrf: CsrfConfig,
    #[serde(default)]
    pub websocket: WebSocketSecurityConfig,
}

/// `hsts = true | false | "raw value" | { max_age, include_subdomains, preload }`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(schemars::JsonSchema), schemars(untagged))]
pub enum HstsSetting {
    Enabled(bool),
    Raw(String),
    Policy(HstsPolicy),
}

/// Picked by the value's type instead of `#[serde(untagged)]`, which tries
/// each variant and reports only "did not match any variant": a table goes
/// straight to `HstsPolicy`, so a typo inside it (`preloadd`) gets serde's
/// unknown-field error - key path, line and closest key included.
impl<'de> Deserialize<'de> for HstsSetting {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct HstsVisitor;

        impl<'de> serde::de::Visitor<'de> for HstsVisitor {
            type Value = HstsSetting;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str(
                    "true, false, a header value, or a table of max_age, \
                     include_subdomains and preload",
                )
            }

            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(HstsSetting::Enabled(value))
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(HstsSetting::Raw(value.to_string()))
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                HstsPolicy::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(HstsSetting::Policy)
            }
        }

        deserializer.deserialize_any(HstsVisitor)
    }
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct HstsPolicy {
    #[serde(default = "default_hsts_max_age")]
    pub max_age: u64,
    #[serde(default)]
    pub include_subdomains: bool,
    #[serde(default)]
    pub preload: bool,
}

pub fn default_hsts_max_age() -> u64 {
    31_536_000
}

/// `[security.csrf]`: cross-site request protection for unsafe methods and
/// WebSocket upgrades. On by default.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct CsrfConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Other origins allowed to send unsafe requests and open WebSockets,
    /// as `scheme://host[:port]` (`https://admin.example.com`).
    #[serde(default)]
    pub trusted_origins: Vec<String>,
    /// Path patterns (rule syntax: `/api/webhooks/*rest`) that skip the
    /// check entirely - for endpoints called cross-site on purpose.
    #[serde(default)]
    pub exempt: Vec<String>,
}

impl Default for CsrfConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            trusted_origins: Vec::new(),
            exempt: Vec::new(),
        }
    }
}

/// `[security.websocket]`: the Origin check on WebSocket upgrades (cross-site
/// WebSocket hijacking). On by default and independent of
/// `[security.csrf] enabled`; it accepts the same `trusted_origins` and
/// skips the same `exempt` paths.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct WebSocketSecurityConfig {
    #[serde(default = "default_true")]
    pub check_origin: bool,
}

impl Default for WebSocketSecurityConfig {
    fn default() -> Self {
        Self { check_origin: true }
    }
}

/// The whole gio.toml. Not `deny_unknown_fields`: top-level keys are checked
/// against `SECTIONS` before deserializing, so `[x-...]` tables can carry
/// settings for other tools.
// `app` is informational: parsed (so its keys are checked) but never read.
#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    test,
    schemars(
        title = "gio.toml",
        description = "GioJS configuration (https://giojs.com/docs/configuration). Unknown keys stop the server at startup; top-level tables named x-* are left for other tools.",
        extend("additionalProperties" = false, "patternProperties" = { "^x-": {} })
    )
)]
pub struct GioConfig {
    #[serde(default)]
    pub app: AppConfig,
    #[serde(default)]
    pub server: ServerConfig,
    /// Self-hosted fonts, fetched at startup and served from /_gio/fonts.
    #[serde(default, rename = "fonts")]
    pub fonts: Vec<FontEntry>,
    #[serde(default)]
    pub images: ImageConfig,
    #[serde(default)]
    pub css: CssConfig,
    #[serde(default)]
    pub websocket: WebsocketConfig,
    /// Token-bucket rate limits per client, evaluated before routing.
    #[serde(default, rename = "rate_limits")]
    pub rate_limits: Vec<RateLimitEntry>,
    #[serde(default)]
    pub i18n: I18nConfig,
    #[serde(default)]
    pub metrics: MetricsConfig,
    #[serde(default)]
    pub cache: CacheConfig,
    #[serde(default)]
    pub compression: CompressionConfig,
    #[serde(default)]
    pub prefetch: PrefetchConfig,
    /// Redirects evaluated in Rust before routing.
    #[serde(default)]
    pub redirects: Vec<crate::rules::RedirectRule>,
    /// Rewrites: serve another route without changing the URL.
    #[serde(default)]
    pub rewrites: Vec<crate::rules::RewriteRule>,
    /// Response headers stamped on matching paths.
    #[serde(default)]
    pub headers: Vec<crate::rules::HeaderRule>,
    /// Cookie / session gates: a request without the credential is
    /// redirected and never reaches Node.
    #[serde(default)]
    pub guards: Vec<crate::rules::GuardRule>,
    #[serde(default)]
    pub dev: DevConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default)]
    pub revalidate: RevalidateConfig,
    /// Where the listen port came from (`GIO_PORT`, `PORT`, `gio.toml` or
    /// `default`), for the startup log.
    #[serde(skip)]
    pub port_source: &'static str,
}

/// Every top-level key `GioConfig` takes, and whether it is an array of
/// tables (`[[fonts]]`). Unknown top-level keys are checked against this
/// list; a test keeps it equal to the struct's fields.
pub const SECTIONS: &[(&str, bool)] = &[
    ("app", false),
    ("server", false),
    ("fonts", true),
    ("images", false),
    ("css", false),
    ("websocket", false),
    ("rate_limits", true),
    ("i18n", false),
    ("metrics", false),
    ("cache", false),
    ("compression", false),
    ("prefetch", false),
    ("redirects", true),
    ("rewrites", true),
    ("headers", true),
    ("guards", true),
    ("dev", false),
    ("security", false),
    ("logging", false),
    ("revalidate", false),
];

/// Keys that earlier releases documented or the example gio.toml carried,
/// but that never did anything. Rejected like any unknown key, with what to
/// do instead of a spelling suggestion.
pub const RETIRED_KEYS: &[(&str, &str)] = &[
    (
        "cache.memory_mb",
        "the memory cache is bounded by entry count: use memory_max_entries (default 1000)",
    ),
    (
        "cache.redis",
        "[cache.redis] is not available yet: GioJS has no Redis cache backend, so each \
         instance keeps its own memory and disk cache. Remove the table",
    ),
    (
        "css.engine",
        "Lightning CSS is the only CSS engine. Remove the key",
    ),
    (
        "prefetch.strategy",
        "the prefetch strategy is chosen per link: <GioLink prefetch=\"hover\" | \"viewport\" \
         | false> (default \"hover\"). Remove the key",
    ),
];

/// `[logging]`: server log output (see logging.rs). `GIO_LOG_FORMAT`
/// overrides `format`. An unknown key or format value is a startup error.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    test,
    schemars(description = "`[logging]`: server log output. GIO_LOG_FORMAT overrides `format`.")
)]
pub struct LoggingConfig {
    #[serde(default)]
    pub format: LogFormat,
}

/// `"text"` (human-readable, the default) or `"json"` (one object per line).
#[derive(Debug, Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub enum LogFormat {
    #[default]
    Text,
    Json,
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

/// `[i18n]`: locale detection and `<html lang>`. An empty `locales` list
/// disables i18n.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct I18nConfig {
    #[serde(default)]
    pub locales: Vec<String>,
    #[serde(default = "default_locale")]
    pub default_locale: String,
    /// Detection order: any of "path", "accept-language", "cookie".
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

/// One `[[rate_limits]]` rule: `per_ip` requests per `window_seconds`, plus
/// `burst`, per client.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RateLimitEntry {
    /// Exact path, or a prefix with a trailing `*` (`/api/*` covers `/api`).
    pub path: String,
    #[serde(default = "default_per_ip")]
    pub per_ip: u64,
    #[serde(default = "default_window_seconds")]
    pub window_seconds: u64,
    #[serde(default = "default_burst")]
    pub burst: u64,
    /// Key buckets on this request header's value instead of the client IP.
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

/// `[websocket]`: WebSocket routes (`route.ts` exporting `WS`).
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct WebsocketConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Concurrent WebSocket connections.
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

/// `[css]`: the Lightning CSS pipeline for app stylesheets.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct CssConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub minify: bool,
    /// Inline the CSS a page's first paint needs.
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

/// `[compression]`: gzip / Brotli for responses, negotiated from
/// Accept-Encoding. Images are never recompressed.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct CompressionConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Responses with a known length below this many bytes are sent as-is
    /// (compressing them costs more than it saves). Streamed responses have
    /// no known length and are always compressed. At most 65535.
    #[serde(default = "default_compression_min_size_bytes")]
    pub min_size_bytes: u16,
    /// true: Brotli for clients that accept it, gzip otherwise. false: gzip
    /// only (every client that accepts Brotli also accepts gzip).
    #[serde(default = "default_true")]
    pub prefer_brotli: bool,
}

fn default_compression_min_size_bytes() -> u16 {
    1024
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_size_bytes: default_compression_min_size_bytes(),
            prefer_brotli: true,
        }
    }
}

/// `[prefetch]`: per-client budgets for prefetch requests (`Purpose:
/// prefetch`, sent by `<GioLink>`). Over budget is a 429, which the client
/// treats as "not prefetched". Which links prefetch is chosen per link.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct PrefetchConfig {
    /// Prefetches one client may have in flight at once. 0 refuses all.
    #[serde(default = "default_prefetch_max_concurrent")]
    pub max_concurrent: usize,
    /// Prefetches one client may start per second. 0 refuses all.
    #[serde(default = "default_prefetch_max_per_second")]
    pub max_per_second: usize,
}

fn default_prefetch_max_concurrent() -> usize {
    5
}
fn default_prefetch_max_per_second() -> usize {
    20
}

impl Default for PrefetchConfig {
    fn default() -> Self {
        Self {
            max_concurrent: default_prefetch_max_concurrent(),
            max_per_second: default_prefetch_max_per_second(),
        }
    }
}

impl PrefetchConfig {
    pub fn budgets(&self) -> giojs_prefetch::PrefetchConfig {
        giojs_prefetch::PrefetchConfig {
            max_in_flight: self.max_concurrent,
            max_per_second: self.max_per_second,
        }
    }
}

/// `[cache]`: the page cache (memory LRU in front of a disk directory).
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema, serde::Serialize))]
pub struct CacheConfig {
    /// Pages kept in the in-memory LRU; the disk cache holds the rest.
    #[serde(default = "default_memory_max_entries")]
    pub memory_max_entries: std::num::NonZeroUsize,
    /// Page cache directory, relative to the project root. GioJS only ever
    /// deletes its own entry files there (`<sha256>.json`), but a dedicated
    /// directory is clearer; it must not be, contain, or sit inside app/ or
    /// public/. GIO_CACHE_DIR overrides it (and may be absolute).
    #[serde(
        default = "default_cache_disk_path",
        deserialize_with = "cache_disk_path"
    )]
    pub disk_path: String,
    /// Disk cache size bound; the oldest entries are evicted past it. 0
    /// disables the bound.
    #[serde(default = "default_cache_disk_max_bytes")]
    pub disk_max_bytes: u64,
}

fn default_memory_max_entries() -> std::num::NonZeroUsize {
    std::num::NonZeroUsize::new(1000).expect("non-zero")
}
fn default_cache_disk_path() -> String {
    ".gio/cache/pages".to_string()
}
fn default_cache_disk_max_bytes() -> u64 {
    512 * 1024 * 1024
}

/// `disk_path` must name a directory below the project root. Clearing and
/// eviction only delete the cache's own entry files
/// (`giojs_cache::is_disk_cache_file`), so other files in the directory are
/// safe either way; but `.` would scatter entries across the project root,
/// and a directory outside the project is what GIO_CACHE_DIR is for.
/// Overlap with app/ and public/ is refused at startup
/// (`check_cache_dir_placement`), once GIO_APP_DIR and GIO_PUBLIC_DIR have
/// placed them.
fn cache_disk_path<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let raw = String::deserialize(deserializer)?;
    let path = std::path::Path::new(&raw);
    let mut normal = 0;
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => normal += 1,
            std::path::Component::CurDir => {}
            _ => {
                return Err(serde::de::Error::custom(
                    "expected a directory inside the project, relative to its root \
                     (\".gio/cache/pages\"); use GIO_CACHE_DIR for a path outside it",
                ))
            }
        }
    }
    if normal == 0 {
        return Err(serde::de::Error::custom(
            "expected a directory below the project root (\".gio/cache/pages\"), \
             not the root itself",
        ));
    }
    Ok(raw)
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            memory_max_entries: default_memory_max_entries(),
            disk_path: default_cache_disk_path(),
            disk_max_bytes: default_cache_disk_max_bytes(),
        }
    }
}

impl CacheConfig {
    /// The page cache directory: `GIO_CACHE_DIR` when set and non-empty,
    /// else `disk_path` under the project root.
    pub fn disk_dir(
        &self,
        project_root: &std::path::Path,
        env_override: Option<&str>,
    ) -> std::path::PathBuf {
        match env_override.filter(|dir| !dir.is_empty()) {
            Some(dir) => std::path::PathBuf::from(dir),
            None => project_root.join(&self.disk_path),
        }
    }
}

/// The page cache directory must keep clear of app/ (the route tree: in dev
/// every change there restarts the worker) and public/ (served as static
/// files, so entries would become public URLs): it may not be either one,
/// sit inside one, or contain one. Checked at startup, before the directory
/// is created, because GIO_APP_DIR and GIO_PUBLIC_DIR decide where those
/// are. Paths are compared resolved (symlinks, `..`), the missing tail of a
/// directory that does not exist yet by name.
pub fn check_cache_dir_placement(
    cache_dir: &std::path::Path,
    app_dir: &std::path::Path,
    public_dir: &std::path::Path,
) -> Result<(), String> {
    let cache = crate::dev_watch::resolve_dir(cache_dir);
    for (name, dir) in [("app/", app_dir), ("public/", public_dir)] {
        let dir = crate::dev_watch::resolve_dir(dir);
        let relation = if cache == dir {
            "is"
        } else if cache.starts_with(&dir) {
            "is inside"
        } else if dir.starts_with(&cache) {
            "contains"
        } else {
            continue;
        };
        return Err(format!(
            "the page cache directory {} {relation} the {name} directory ({}) - give the \
             cache a directory of its own, such as .gio/cache/pages",
            cache_dir.display(),
            dir.display(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemotePattern {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub hostname: String,
    /// Exact path, or a prefix with a trailing `*`.
    pub pathname: Option<String>,
}

fn default_protocol() -> String {
    "https".to_string()
}

/// A modern format `/_gio/image` may negotiate from the Accept header.
/// JPEG (PNG for `f=png`) is always the fallback.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    test,
    derive(schemars::JsonSchema, serde::Serialize),
    schemars(transform = image_format_schema_aliases)
)]
pub enum ImageFormat {
    #[serde(rename = "avif", alias = "image/avif")]
    Avif,
    #[serde(rename = "webp", alias = "image/webp")]
    Webp,
}

/// `[images]`: the `/_gio/image` optimizer and `<GioImage>` srcsets.
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ImageConfig {
    /// The only widths `/_gio/image` resizes to (anything else is a 400),
    /// and the `<GioImage>` srcset candidates.
    #[serde(default = "default_allowed_widths")]
    pub allowed_widths: Vec<u32>,
    /// Default output quality, 1-100.
    #[serde(default = "default_image_quality")]
    pub quality: u8,
    /// Remote image sources the optimizer may fetch; none by default.
    #[serde(default)]
    pub remote_patterns: Vec<RemotePattern>,
    /// On-disk optimized-image cache cap.
    #[serde(default = "default_image_disk_max_bytes")]
    pub disk_max_bytes: u64,
    /// Largest remote source the optimizer downloads.
    #[serde(default = "default_image_max_remote_bytes")]
    pub max_remote_bytes: u64,
    /// Modern formats to serve when the browser accepts them, in order of
    /// preference; everything else gets JPEG. Leave AVIF out to save CPU:
    /// it is several times slower to encode than WebP.
    #[serde(default = "default_image_formats")]
    pub formats: Vec<ImageFormat>,
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

fn default_image_formats() -> Vec<ImageFormat> {
    vec![ImageFormat::Avif, ImageFormat::Webp]
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            allowed_widths: default_allowed_widths(),
            quality: default_image_quality(),
            remote_patterns: Vec::new(),
            disk_max_bytes: default_image_disk_max_bytes(),
            max_remote_bytes: default_image_max_remote_bytes(),
            formats: default_image_formats(),
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

    /// `formats` as the optimizer's negotiation order, duplicates dropped.
    pub fn negotiated_formats(&self) -> Vec<giojs_image::processor::OutputFormat> {
        let mut formats = Vec::new();
        for format in &self.formats {
            let format = match format {
                ImageFormat::Avif => giojs_image::processor::OutputFormat::Avif,
                ImageFormat::Webp => giojs_image::processor::OutputFormat::WebP,
            };
            if !formats.contains(&format) {
                formats.push(format);
            }
        }
        formats
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct FontEntry {
    pub family: String,
    /// A file under public/ ("/fonts/inter.woff2"), copied at every start, or
    /// an https:// woff2 URL, downloaded on the first start.
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

/// `[app]`: informational; nothing in the server reads it.
#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AppConfig {
    pub name: Option<String>,
    /// The app/ directory router - the only router GioJS has.
    pub router: Option<AppRouter>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub enum AppRouter {
    #[serde(rename = "app")]
    App,
}

/// `[server]`: the listener. GIO_HOST overrides `host`; GIO_PORT, then
/// PORT, override `port`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ServerConfig {
    /// IP address to bind: "0.0.0.0" (every interface), "127.0.0.1" (this
    /// machine only), or IPv6 in brackets ("[::]", "[::1]"). Overridden by
    /// GIO_HOST.
    #[serde(default = "default_host", deserialize_with = "listen_host")]
    pub host: String,
    /// Overridden by GIO_PORT, then PORT.
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_http2")]
    pub http2: bool,
    /// Request body limit.
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
    /// Reverse proxies (IPs or CIDR blocks) whose forwarding headers name
    /// the client. Empty = trust nobody: the TCP peer is the client and
    /// forwarding headers are ignored. A malformed entry fails startup.
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Vec<String>"))]
    pub trusted_proxies: crate::client_identity::TrustedProxies,
    /// Which forwarding headers the trusted proxies set: "x-forwarded"
    /// (X-Forwarded-For/-Proto/-Host, default) or "forwarded" (RFC 7239).
    #[serde(default)]
    pub proxy_headers: crate::client_identity::ProxyHeaders,
    /// Adopt a valid X-Request-Id sent by a trusted proxy (default). False
    /// generates every id here - for proxies that pass a client's own
    /// X-Request-Id through instead of setting one (AWS ALB, Google Cloud LB).
    #[serde(default = "default_accept_request_id")]
    pub accept_request_id: bool,
    /// Node render workers: 1 (default), a count, or "auto".
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "WorkersSchema"))]
    pub workers: WorkersSetting,
    #[serde(default)]
    pub tls: TlsConfig,
}

/// Largest explicit `[server] workers` count: a sanity bound, since every
/// worker is a full Node process with its own copy of the app in memory.
pub const MAX_WORKERS: usize = 64;

/// `[server] workers = 1 | N | "auto"`: how many Node processes render.
/// "auto" is one per available CPU core, at most `ipc::AUTO_WORKERS_MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkersSetting {
    Count(usize),
    Auto,
}

// Schema-only mirror of the spellings `WorkersSetting` accepts (its
// Deserialize is hand-written); the doc comment below is what editors show.
/// Node render workers: a count from 1 to 64, or "auto" (one per CPU core,
/// at most 8).
#[cfg(test)]
#[derive(schemars::JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum WorkersSchema {
    Count(#[schemars(range(min = 1, max = 64))] u64),
    Auto(WorkersAuto),
}

#[cfg(test)]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
enum WorkersAuto {
    #[serde(rename = "auto")]
    Auto,
}

impl Default for WorkersSetting {
    /// One worker keeps a fresh install's memory profile; more is opt-in.
    fn default() -> Self {
        WorkersSetting::Count(1)
    }
}

impl WorkersSetting {
    /// The worker count, given the cores available (None when unknown).
    pub fn resolve(self, available_cores: Option<usize>) -> usize {
        match self {
            WorkersSetting::Count(count) => count,
            WorkersSetting::Auto => available_cores
                .unwrap_or(1)
                .clamp(1, crate::ipc::AUTO_WORKERS_MAX),
        }
    }
}

impl<'de> Deserialize<'de> for WorkersSetting {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Count(i64),
            Name(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Count(count) if (1..=MAX_WORKERS as i64).contains(&count) => {
                Ok(WorkersSetting::Count(count as usize))
            }
            Raw::Name(name) if name == "auto" => Ok(WorkersSetting::Auto),
            Raw::Count(count) => Err(D::Error::custom(format!(
                "workers = {count}: expected 1 to {MAX_WORKERS}, or \"auto\""
            ))),
            Raw::Name(name) => Err(D::Error::custom(format!(
                "workers = {name:?}: expected a count (1 to {MAX_WORKERS}) or \"auto\""
            ))),
        }
    }
}

fn default_host() -> String {
    "0.0.0.0".to_string()
}

fn default_port() -> u16 {
    3000
}

/// `bind_addr()` joins host and port and parses a SocketAddr, so a hostname
/// such as "localhost" would only fail later with a vaguer error.
fn listen_host<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let host = String::deserialize(deserializer)?;
    if is_listen_host(&host) {
        Ok(host)
    } else {
        Err(serde::de::Error::custom(LISTEN_HOST_EXPECTED))
    }
}

const LISTEN_HOST_EXPECTED: &str = "expected an IP address such as 0.0.0.0 (every interface), \
     127.0.0.1 (this machine only), or IPv6 in brackets ([::], [::1])";

fn is_listen_host(host: &str) -> bool {
    format!("{host}:0").parse::<std::net::SocketAddr>().is_ok()
}

fn default_http2() -> bool {
    true
}

fn default_accept_request_id() -> bool {
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

/// `[server.tls]`: terminate TLS in GioJS itself.
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct TlsConfig {
    #[serde(default)]
    pub enabled: bool,
    pub cert_path: Option<String>,
    pub key_path: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
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
            trusted_proxies: Default::default(),
            proxy_headers: Default::default(),
            accept_request_id: default_accept_request_id(),
            workers: WorkersSetting::default(),
            tls: TlsConfig::default(),
        }
    }
}

impl GioConfig {
    pub fn load() -> Self {
        match Self::try_load() {
            Ok(config) => config,
            Err(error) => {
                eprintln!("giojs-server: configuration error: {error}");
                std::process::exit(1);
            }
        }
    }

    /// `load` without the exit: the config, or why startup would refuse it.
    pub fn try_load() -> Result<Self, ConfigError> {
        let mut config = Self::load_from_path(&Self::path())?;
        config.apply_listen_overrides(
            std::env::var("GIO_HOST").ok().as_deref(),
            std::env::var("GIO_PORT").ok().as_deref(),
            std::env::var("PORT").ok().as_deref(),
        )?;
        Ok(config)
    }

    /// Where gio.toml is read from. GIO_APP_DIR is the `app/` subdirectory
    /// and gio.toml lives one level up; fall back to gio.toml in the process
    /// CWD if that path doesn't exist.
    pub fn path() -> std::path::PathBuf {
        std::env::var("GIO_APP_DIR")
            .ok()
            .and_then(|app_dir| {
                let p = std::path::Path::new(&app_dir).parent()?.join("gio.toml");
                p.exists().then_some(p)
            })
            .unwrap_or_else(|| std::path::PathBuf::from("gio.toml"))
    }

    fn load_from_path(path: &std::path::Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Ok(Self {
                port_source: "default",
                ..Self::default()
            });
        }
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.display().to_string(),
            source,
        })?;
        Self::parse(&raw, &path.display().to_string())
    }

    /// Parse gio.toml's contents; `file` names it in errors.
    pub(crate) fn parse(raw: &str, file: &str) -> Result<Self, ConfigError> {
        let parsed = toml::from_str::<Self>(raw);
        // A syntax error leaves no document: toml's own error (line,
        // snippet) is then the best there is.
        let doc = toml_edit::ImDocument::parse(raw).ok();
        if let Some(doc) = &doc {
            check_sections(doc, raw, file)?;
        }
        let mut config =
            parsed.map_err(|source| describe_error(source, doc.as_ref(), raw, file))?;
        for guard in &config.guards {
            guard
                .validate()
                .map_err(|source| ConfigError::InvalidGuard {
                    path: file.to_string(),
                    guard: guard.path.clone(),
                    source,
                })?;
        }
        let port_in_file = doc
            .as_ref()
            .and_then(|doc| doc.as_table().get("server"))
            .and_then(|server| server.get("port"))
            .is_some();
        config.port_source = if port_in_file { "gio.toml" } else { "default" };
        Ok(config)
    }

    /// Env wins over gio.toml: `GIO_HOST` over `[server] host`, and
    /// `GIO_PORT`, then `PORT`, over `[server] port` - so one gio.toml can
    /// serve instances on other addresses without being edited (test
    /// servers on free ports, and the platforms that assign the port through
    /// `PORT`: Heroku, Render, Railway, Fly.io, Cloud Run). `HOST` is not
    /// read: shells and CI images set it to the machine's hostname. Empty
    /// values are ignored; a malformed one stops startup like a bad gio.toml
    /// rather than silently binding somewhere else.
    fn apply_listen_overrides(
        &mut self,
        host: Option<&str>,
        port: Option<&str>,
        platform_port: Option<&str>,
    ) -> Result<(), ConfigError> {
        if let Some(host) = host.filter(|h| !h.is_empty()) {
            if !is_listen_host(host) {
                return Err(ConfigError::InvalidEnv {
                    name: "GIO_HOST",
                    value: host.to_string(),
                    reason: LISTEN_HOST_EXPECTED,
                });
            }
            self.server.host = host.to_string();
        }
        let port_override = [("GIO_PORT", port), ("PORT", platform_port)]
            .into_iter()
            .find_map(|(name, value)| Some((name, value.filter(|p| !p.is_empty())?)));
        if let Some((name, port)) = port_override {
            self.server.port = port.parse().map_err(|_| ConfigError::InvalidEnv {
                name,
                value: port.to_string(),
                reason: "expected a port number (0-65535)",
            })?;
            self.port_source = name;
        }
        Ok(())
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

/// Top-level keys must be a `SECTIONS` entry or start with `x-` (left for
/// other tools). `GioConfig` itself does not deny unknown fields, so this is
/// the only check at this level.
fn check_sections(
    doc: &toml_edit::ImDocument<&str>,
    raw: &str,
    file: &str,
) -> Result<(), ConfigError> {
    let root = doc.as_table();
    for (name, item) in root.iter() {
        if name.starts_with("x-") || SECTIONS.iter().any(|(section, _)| *section == name) {
            continue;
        }
        let line = root
            .key(name)
            .and_then(|key| key.span())
            .map(|span| config_diagnostics::line_of(raw, span.start));
        let suggestion =
            config_diagnostics::closest(name, SECTIONS.iter().map(|(section, _)| *section))
                .and_then(|section| SECTIONS.iter().find(|(known, _)| *known == section))
                .map(|(section, array)| {
                    let kind = if *array {
                        config_diagnostics::KeyKind::ArrayOfTables
                    } else {
                        config_diagnostics::KeyKind::Table
                    };
                    format!(
                        " - did you mean {}?",
                        config_diagnostics::display_key(section, kind)
                    )
                });
        return Err(ConfigError::UnknownKey {
            location: location(file, line),
            key: config_diagnostics::display_key(name, config_diagnostics::kind_of(item)),
            hint: suggestion.unwrap_or_else(|| {
                " - tables for other tools must be named x-... ([x-mytool])".to_string()
            }),
        });
    }
    Ok(())
}

/// `file:line`, or just `file` without a line.
fn location(file: &str, line: Option<usize>) -> String {
    match line {
        Some(line) => format!("{file}:{line}"),
        None => file.to_string(),
    }
}

/// toml's multi-line messages ("invalid string\nexpected `\"`") on one line.
fn one_line(message: &str) -> String {
    message
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

/// A deserialization error with the key path and line it belongs to, and
/// for an unknown key the closest valid key at that level (or what replaced
/// a retired one).
fn describe_error(
    source: toml::de::Error,
    doc: Option<&toml_edit::ImDocument<&str>>,
    raw: &str,
    file: &str,
) -> ConfigError {
    let located = doc.zip(source.span()).and_then(|(doc, span)| {
        config_diagnostics::key_at(doc, span.start).map(|key| (key, span.start))
    });
    let Some((key, offset)) = located else {
        let location = match source.span() {
            Some(span) => {
                let before = raw.get(..span.start).unwrap_or(raw);
                let line_start = before.rfind('\n').map_or(0, |newline| newline + 1);
                let column = before[line_start..].chars().count() + 1;
                let line = config_diagnostics::line_of(raw, before.len());
                format!("{}:{column}", location(file, Some(line)))
            }
            None => file.to_string(),
        };
        return ConfigError::Parse { location, source };
    };
    let location = location(file, Some(config_diagnostics::line_of(raw, offset)));
    let message = source.message().trim_end();
    let unknown = config_diagnostics::parse_unknown(message);
    let suggestion = unknown.as_ref().and_then(|unknown| {
        config_diagnostics::closest(&unknown.name, unknown.expected.iter().map(String::as_str))
    });
    match &unknown {
        Some(unknown) if !unknown.variant => {
            let bare_path = strip_indexes(&key.path);
            let retired = RETIRED_KEYS.iter().find(|(path, _)| *path == bare_path);
            let hint = match (retired, suggestion) {
                (Some((_, hint)), _) => format!(" - {hint}"),
                (None, Some(suggestion)) => {
                    let path = match key.path.rsplit_once('.') {
                        Some((parent, _)) => format!("{parent}.{suggestion}"),
                        None => suggestion.to_string(),
                    };
                    format!(
                        " - did you mean {}?",
                        config_diagnostics::display_key(&path, key.kind)
                    )
                }
                (None, None) if unknown.expected.is_empty() => String::new(),
                (None, None) => format!(" - expected one of: {}", unknown.expected.join(", ")),
            };
            ConfigError::UnknownKey {
                location,
                key: config_diagnostics::display_key(&key.path, key.kind),
                hint,
            }
        }
        _ => {
            let hint = suggestion
                .map(|suggestion| format!(" - did you mean \"{suggestion}\"?"))
                .unwrap_or_default();
            ConfigError::InvalidValue {
                location,
                key: format!("`{}`", key.path),
                message: format!("{message}{hint}"),
            }
        }
    }
}

/// `guards[1].path` -> `guards.path`, for matching `RETIRED_KEYS`.
fn strip_indexes(path: &str) -> String {
    path.split('.')
        .map(|segment| segment.split_once('[').map_or(segment, |(name, _)| name))
        .collect::<Vec<_>>()
        .join(".")
}

/// schemars renders neither serde's field aliases nor its variant aliases,
/// so the editor schema would flag spellings the parser accepts. These add
/// them; `schema_accepts_every_spelling_the_parser_does` keeps them in step.
///
/// Each `(field, alias)` becomes a property of its own, and the schema
/// allows at most one spelling of a field (serde rejects both as a duplicate
/// field) - exactly one when the field is required.
#[cfg(test)]
pub(crate) fn add_schema_field_aliases(schema: &mut schemars::Schema, aliases: &[(&str, &str)]) {
    use serde_json::{json, Value};
    let object = schema.as_object_mut().expect("an object schema");
    let required: Vec<Value> = object
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut constraints = Vec::new();
    let properties = object
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .expect("properties");
    for (field, alias) in aliases {
        let mut property = properties[*field].clone();
        if let Some(property) = property.as_object_mut() {
            property.remove("default");
            property.insert("description".into(), format!("Same as `{field}`.").into());
        }
        properties.insert(alias.to_string(), property);
        constraints.push(if required.contains(&json!(field)) {
            json!({ "oneOf": [{ "required": [field] }, { "required": [alias] }] })
        } else {
            json!({ "not": { "required": [field, alias] } })
        });
    }
    if let Some(Value::Array(required)) = object.get_mut("required") {
        required.retain(|name| !aliases.iter().any(|(field, _)| name == field));
    }
    object.insert("allOf".into(), Value::Array(constraints));
}

/// `ImageFormat` also takes the MIME types (`image/avif`), the spelling
/// Next.js's `images.formats` uses.
#[cfg(test)]
fn image_format_schema_aliases(schema: &mut schemars::Schema) {
    let values = schema
        .get_mut("enum")
        .and_then(serde_json::Value::as_array_mut)
        .expect("an enum schema");
    values.extend(["image/avif", "image/webp"].map(serde_json::Value::from));
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
        assert_eq!(config.logging.format, LogFormat::Text);
    }

    #[test]
    fn logging_format_parses_and_rejects_unknown_values() {
        let path = unique_temp_path("logging_json.toml");
        std::fs::write(&path, "[logging]\nformat = \"json\"\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap().logging.format, LogFormat::Json);

        let path = unique_temp_path("logging_bad.toml");
        std::fs::write(&path, "[logging]\nformat = \"logfmt\"\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert!(matches!(result, Err(ConfigError::InvalidValue { .. })));
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
    fn revalidate_section_parses_and_rejects_misspelled_keys() {
        let path = unique_temp_path("revalidate.toml");
        std::fs::write(&path, "[revalidate]\ntoken = \"abc\"\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        assert_eq!(result.unwrap().revalidate.token, "abc");

        std::fs::write(&path, "[revalidate]\ntokn = \"abc\"\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert!(matches!(result, Err(ConfigError::UnknownKey { .. })));
        assert!(GioConfig::default().revalidate.token.is_empty());
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

    fn load_server_toml(name: &str, server_body: &str) -> Result<GioConfig, ConfigError> {
        let path = unique_temp_path(name);
        std::fs::write(
            &path,
            format!("[server]\nhost = \"127.0.0.1\"\nport = 4321\n{server_body}"),
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        result
    }

    #[test]
    fn workers_default_to_one_and_parse_counts_and_auto() {
        let omitted = load_server_toml("workers_default.toml", "").unwrap();
        assert_eq!(omitted.server.workers, WorkersSetting::Count(1));
        assert_eq!(ServerConfig::default().workers, WorkersSetting::Count(1));
        let four = load_server_toml("workers_four.toml", "workers = 4\n").unwrap();
        assert_eq!(four.server.workers, WorkersSetting::Count(4));
        assert_eq!(
            four.server.workers.resolve(Some(2)),
            4,
            "an explicit count is exact"
        );
        let auto = load_server_toml("workers_auto.toml", "workers = \"auto\"\n").unwrap();
        assert_eq!(auto.server.workers, WorkersSetting::Auto);
    }

    #[test]
    fn auto_workers_follow_the_cores_up_to_the_cap() {
        assert_eq!(WorkersSetting::Auto.resolve(Some(3)), 3);
        assert_eq!(
            WorkersSetting::Auto.resolve(Some(64)),
            crate::ipc::AUTO_WORKERS_MAX
        );
        assert_eq!(WorkersSetting::Auto.resolve(None), 1, "unknown core count");
        assert_eq!(WorkersSetting::Auto.resolve(Some(0)), 1);
    }

    #[test]
    fn invalid_worker_counts_stop_startup() {
        for (name, body) in [
            ("workers_zero.toml", "workers = 0\n"),
            ("workers_negative.toml", "workers = -2\n"),
            ("workers_huge.toml", "workers = 65\n"),
            ("workers_word.toml", "workers = \"many\"\n"),
            ("workers_float.toml", "workers = 1.5\n"),
        ] {
            let err = load_server_toml(name, body).expect_err(body);
            assert!(
                matches!(err, ConfigError::Parse { .. } | ConfigError::InvalidValue { .. }),
                "{body}: {err}"
            );
        }
        let err = load_server_toml("workers_zero_msg.toml", "workers = 0\n").unwrap_err();
        assert!(err.to_string().contains("expected 1 to 64"), "{err}");
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
    fn trusted_proxies_parse_and_default_to_trusting_nobody() {
        use crate::client_identity::ProxyHeaders;
        let missing = GioConfig::load_from_path(&unique_temp_path("no_proxies.toml")).unwrap();
        assert!(missing.server.trusted_proxies.is_empty());
        assert_eq!(missing.server.proxy_headers, ProxyHeaders::XForwarded);
        assert!(missing.server.accept_request_id);

        let path = unique_temp_path("proxies_defaults.toml");
        std::fs::write(&path, "[server]\nhost = \"127.0.0.1\"\nport = 1\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.unwrap().server.accept_request_id);

        let path = unique_temp_path("proxies.toml");
        std::fs::write(
            &path,
            "[server]\nhost = \"127.0.0.1\"\nport = 1\n\
             trusted_proxies = [\"127.0.0.1\", \"10.0.0.0/8\", \"::1\"]\n\
             proxy_headers = \"forwarded\"\n\
             accept_request_id = false\n",
        )
        .unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let server = result.unwrap().server;
        assert!(!server.accept_request_id);
        assert!(server
            .trusted_proxies
            .contains("10.20.30.40".parse().unwrap()));
        assert!(server.trusted_proxies.contains("::1".parse().unwrap()));
        assert!(!server
            .trusted_proxies
            .contains("192.0.2.1".parse().unwrap()));
        assert_eq!(server.proxy_headers, ProxyHeaders::Forwarded);
    }

    #[test]
    fn malformed_trusted_proxies_fail_to_load() {
        // Trust config is never silently shortened: a typo is a startup error.
        for bad in [
            "trusted_proxies = [\"10.0.0.0/33\"]",
            "trusted_proxies = [\"proxy.internal\"]",
            "proxy_headers = \"x-real-ip\"",
        ] {
            let path = unique_temp_path("bad_proxies.toml");
            std::fs::write(
                &path,
                format!("[server]\nhost = \"127.0.0.1\"\nport = 1\n{bad}\n"),
            )
            .unwrap();
            let result = GioConfig::load_from_path(&path);
            let _ = std::fs::remove_file(&path);
            assert!(
                matches!(result, Err(ConfigError::InvalidValue { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn security_section_defaults_when_absent() {
        let config = GioConfig::load_from_path(&unique_temp_path("no_security.toml")).unwrap();
        let security = config.security;
        assert!(security.headers.is_empty());
        assert_eq!(security.hsts, None);
        assert_eq!(security.csp, None);
        assert!(security.csrf.enabled, "CSRF protection is on by default");
        assert!(security.csrf.trusted_origins.is_empty());
        assert!(security.csrf.exempt.is_empty());
        assert!(
            security.websocket.check_origin,
            "the WebSocket origin check is on by default"
        );
    }

    #[test]
    fn security_section_parses_every_hsts_spelling() {
        let parse = |body: &str| {
            let path = unique_temp_path("security.toml");
            std::fs::write(&path, body).unwrap();
            let result = GioConfig::load_from_path(&path);
            let _ = std::fs::remove_file(&path);
            result
        };
        let config = parse(
            r#"
[security]
hsts = { max_age = 63072000, include_subdomains = true }
csp = "default-src 'self'; script-src 'nonce-{nonce}'"

[security.headers]
x-frame-options = "DENY"
referrer-policy = ""

[security.csrf]
enabled = false
trusted_origins = ["https://admin.example.com"]
exempt = ["/api/webhooks/*rest"]

[security.websocket]
check_origin = true
"#,
        )
        .unwrap();
        let security = config.security;
        assert!(!security.csrf.enabled);
        assert!(
            security.websocket.check_origin,
            "switched separately from CSRF"
        );
        assert_eq!(
            security.hsts,
            Some(HstsSetting::Policy(HstsPolicy {
                max_age: 63_072_000,
                include_subdomains: true,
                preload: false,
            }))
        );
        assert_eq!(
            security.headers.get("referrer-policy").map(String::as_str),
            Some("")
        );
        assert_eq!(security.csrf.exempt, vec!["/api/webhooks/*rest"]);
        assert!(security.csp.unwrap().contains("{nonce}"));

        let flag = parse("[security]\nhsts = true\n").unwrap();
        assert_eq!(flag.security.hsts, Some(HstsSetting::Enabled(true)));
        let raw = parse("[security]\nhsts = \"max-age=60\"\n").unwrap();
        assert_eq!(
            raw.security.hsts,
            Some(HstsSetting::Raw("max-age=60".to_string()))
        );
    }

    #[test]
    fn misspelled_security_keys_fail_loudly() {
        for body in [
            "[security]\ncps = \"default-src 'self'\"\n",
            "[security.csrf]\ntrusted_origin = [\"https://a.example\"]\n",
            "[security]\nhsts = { maxage = 10 }\n",
            "[security.websocket]\ncheck_origins = false\n",
        ] {
            let path = unique_temp_path("security_typo.toml");
            std::fs::write(&path, body).unwrap();
            let result = GioConfig::load_from_path(&path);
            let _ = std::fs::remove_file(&path);
            assert!(
                matches!(
                    result,
                    Err(ConfigError::UnknownKey { .. } | ConfigError::InvalidValue { .. })
                ),
                "{body} must be rejected"
            );
        }
    }

    #[test]
    fn syntax_errors_give_a_position_never_the_line() {
        let secret = "s3cr3t-revalidate-token-0123456789abcdef";
        for (raw, position) in [
            (format!("[revalidate]\ntoken = \"{secret}\" extra\n"), "gio.toml:2:"),
            (format!("[revalidate]\ntoken = \"{secret}\n"), "gio.toml:2:"),
            (format!("[metrics]\ntoken = '{secret}' = 1\n"), "gio.toml:2:"),
            (format!("[revalidate]\ntoken = {secret}\n"), "gio.toml:2:"),
            (format!("[metrics]\ntoken = \"{secret}\"\ntoken = \"{secret}\"\n"), "gio.toml:3:"),
        ] {
            let err = GioConfig::parse(&raw, "gio.toml").expect_err(&raw);
            let message = err.to_string();
            assert!(matches!(err, ConfigError::Parse { .. }), "{raw}: {message}");
            assert!(!message.contains("s3cr3t"), "the value leaked: {message}");
            assert!(message.starts_with(&format!("cannot parse {position}")), "{message}");
            assert!(!message.contains('\n'), "one line: {message}");
        }
        let err = GioConfig::parse("[revalidate]\ntoken = \"x\" extra\n", "gio.toml").unwrap_err();
        assert!(
            err.to_string().starts_with("cannot parse gio.toml:2:13: "),
            "line and column of the stray text: {err}"
        );
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
    fn listen_env_overrides_win_over_gio_toml() {
        let path = unique_temp_path("listen_env.toml");
        std::fs::write(&path, "[server]\nhost = \"0.0.0.0\"\nport = 4321\n").unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        let mut config = result.unwrap();

        config.apply_listen_overrides(None, None, None).unwrap();
        assert_eq!(config.bind_addr(), "0.0.0.0:4321");
        assert_eq!(config.port_source, "gio.toml");
        // Empty values (`GIO_PORT=` in a shell) leave gio.toml in charge.
        config
            .apply_listen_overrides(Some(""), Some(""), Some(""))
            .unwrap();
        assert_eq!(config.bind_addr(), "0.0.0.0:4321");

        config
            .apply_listen_overrides(Some("127.0.0.1"), Some("39999"), None)
            .unwrap();
        assert_eq!(config.bind_addr(), "127.0.0.1:39999");
        assert!(config.bind_addr().parse::<std::net::SocketAddr>().is_ok());
    }

    #[test]
    fn malformed_listen_env_stops_startup_without_changing_the_address() {
        let mut config = GioConfig::default();
        let before = config.bind_addr();
        for (host, port, platform_port, name) in [
            (Some("localhost"), None, None, "GIO_HOST"),
            (Some("127.0.0.1:80"), None, None, "GIO_HOST"),
            (None, Some("70000"), None, "GIO_PORT"),
            (None, Some("http"), None, "GIO_PORT"),
            (None, Some("-1"), None, "GIO_PORT"),
            (None, None, Some("80a"), "PORT"),
            (None, None, Some("65536"), "PORT"),
        ] {
            let err = config
                .apply_listen_overrides(host, port, platform_port)
                .unwrap_err();
            assert!(
                matches!(err, ConfigError::InvalidEnv { name: n, .. } if n == name),
                "{host:?} {port:?}: {err}"
            );
            assert!(err.to_string().contains(name));
        }
        assert_eq!(config.bind_addr(), before);
    }

    fn load_guard_toml(name: &str, guard_body: &str) -> Result<GioConfig, ConfigError> {
        let path = unique_temp_path(name);
        std::fs::write(&path, format!("[[guards]]\n{guard_body}")).unwrap();
        let result = GioConfig::load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        result
    }

    #[test]
    fn misspelled_guard_requirement_stops_startup() {
        // A guard that loaded with the typo ignored would leave /admin open.
        for typo in ["require_sesion", "require-session", "requireSesion"] {
            let result = load_guard_toml(
                &format!("guard_typo_{typo}.toml"),
                &format!("path = \"/admin/*rest\"\n{typo} = true\nredirect_to = \"/login\"\n"),
            );
            assert!(
                matches!(result, Err(ConfigError::UnknownKey { .. })),
                "{typo}: {result:?}"
            );
        }
    }

    #[test]
    fn guard_that_would_not_protect_its_path_stops_startup() {
        for (name, body) in [
            (
                "guard_none.toml",
                "path = \"/admin/*rest\"\nredirect_to = \"/login\"\n",
            ),
            (
                "guard_session_false.toml",
                "path = \"/admin\"\nrequire_session = false\nredirect_to = \"/\"\n",
            ),
            (
                "guard_empty_cookie.toml",
                "path = \"/admin\"\nrequire_cookie = \"\"\nredirect_to = \"/\"\n",
            ),
            (
                "guard_relative.toml",
                "path = \"admin\"\nrequire_session = true\nredirect_to = \"/\"\n",
            ),
            (
                "guard_relative_target.toml",
                "path = \"/admin\"\nrequire_session = true\nredirect_to = \"login\"\n",
            ),
        ] {
            let result = load_guard_toml(name, body);
            assert!(
                matches!(result, Err(ConfigError::InvalidGuard { .. })),
                "{name}: {result:?}"
            );
        }
        let ok = load_guard_toml(
            "guard_session_ok.toml",
            "path = \"/admin/*rest\"\nrequire_session = true\nredirect_to = \"/login\"\n",
        )
        .expect("a valid session guard loads");
        assert!(ok.guards[0].require_session);
    }

    fn parse(body: &str) -> Result<GioConfig, ConfigError> {
        GioConfig::parse(body, "gio.toml")
    }

    fn error_text(body: &str) -> String {
        match parse(body) {
            Ok(_) => panic!("{body:?} must be rejected"),
            Err(error) => error.to_string(),
        }
    }

    #[test]
    fn unknown_keys_name_the_path_line_and_closest_valid_key() {
        for (body, expected) in [
            (
                "[image]\nquality = 80\n",
                "gio.toml:1: unknown key [image] - did you mean [images]?",
            ),
            (
                "[app]\nname = \"x\"\n\n[[rate_limit]]\npath = \"/api/*\"\n",
                "gio.toml:4: unknown key [[rate_limit]] - did you mean [[rate_limits]]?",
            ),
            (
                "[images]\nallowed_width = [640]\n",
                "gio.toml:2: unknown key `images.allowed_width` - did you mean `images.allowed_widths`?",
            ),
            (
                "[server.tls]\nenable = true\n",
                "gio.toml:2: unknown key `server.tls.enable` - did you mean `server.tls.enabled`?",
            ),
            (
                "[[guards]]\npath = \"/a\"\nrequire_session = true\nredirect_to = \"/\"\n\n\
                 [[guards]]\npath = \"/b\"\nrequire_sesion = true\nredirect_to = \"/\"\n",
                "gio.toml:8: unknown key `guards[1].require_sesion` - did you mean `guards[1].require_session`?",
            ),
            (
                "[[images.remote_patterns]]\nhostnam = \"cdn.example.com\"\n",
                "gio.toml:2: unknown key `images.remote_patterns[0].hostnam` - did you mean \
                 `images.remote_patterns[0].hostname`?",
            ),
            (
                "[security.csrff]\nenabled = false\n",
                "gio.toml:1: unknown key [security.csrff] - did you mean [security.csrf]?",
            ),
            (
                "[security]\nhsts = true\ncps = \"default-src 'self'\"\n",
                "gio.toml:3: unknown key `security.cps` - did you mean `security.csp`?",
            ),
            (
                "[security]\nhsts = { max_age = 1, preloadd = true }\n",
                "gio.toml:2: unknown key `security.hsts.preloadd` - did you mean `security.hsts.preload`?",
            ),
            (
                "[security.hsts]\nmax_age = 1\n\ninclude_subdomain = true\n",
                "gio.toml:4: unknown key `security.hsts.include_subdomain` - did you mean \
                 `security.hsts.include_subdomains`?",
            ),
            (
                "[server]\nport = 3000\n[server.limits]\nmax = 1\n",
                "gio.toml:3: unknown key [server.limits] - expected one of: host, port,",
            ),
            (
                "prot = 3000\n",
                "gio.toml:1: unknown key `prot` - tables for other tools must be named x-...",
            ),
        ] {
            let text = error_text(body);
            assert!(text.starts_with(expected), "{body:?}\n got: {text}\nwant: {expected}");
        }
    }

    #[test]
    fn x_tables_are_left_for_other_tools() {
        let config = parse(
            "[x-deploy]\nregion = \"eu\"\n\n[x-mytool.nested]\nlist = [1, 2]\n\n[server]\nport = 4000\n",
        )
        .unwrap();
        assert_eq!(config.server.port, 4000);
        // Only at the top level: nested x- keys are typos like any other.
        assert!(matches!(
            parse("[server]\nx-port = 1\n"),
            Err(ConfigError::UnknownKey { .. })
        ));
    }

    #[test]
    fn retired_keys_are_rejected_with_what_to_do_instead() {
        for (body, key, hint) in [
            (
                "[cache]\nmemory_mb = 50\n",
                "`cache.memory_mb`",
                "memory_max_entries",
            ),
            (
                "[cache.redis]\nenabled = false\nurl = \"redis://localhost:6379\"\n",
                "[cache.redis]",
                "not available yet",
            ),
            (
                "[css]\nengine = \"lightning\"\n",
                "`css.engine`",
                "only CSS engine",
            ),
            (
                "[prefetch]\nstrategy = \"hover\"\n",
                "`prefetch.strategy`",
                "<GioLink prefetch=",
            ),
        ] {
            let text = error_text(body);
            assert!(text.contains(&format!("unknown key {key}")), "{text}");
            assert!(text.contains(hint), "{text}");
        }
    }

    #[test]
    fn invalid_values_name_the_key_and_line() {
        for (body, expected) in [
            ("[server]\nport = \"http\"\n", "gio.toml:2: invalid `server.port`: invalid type"),
            (
                "[logging]\nformat = \"jsno\"\n",
                "gio.toml:2: invalid `logging.format`: unknown variant `jsno`, expected `text` or `json` - did you mean \"json\"?",
            ),
            ("[server]\nhost = \"localhost\"\n", "gio.toml:2: invalid `server.host`: expected an IP address"),
            (
                "[server]\nhost = \"::1\"\n",
                "gio.toml:2: invalid `server.host`: expected an IP address such as 0.0.0.0 \
                 (every interface), 127.0.0.1 (this machine only), or IPv6 in brackets ([::], [::1])",
            ),
            (
                "[security]\nhsts = 5\n",
                "gio.toml:2: invalid `security.hsts`: invalid type: integer `5`, expected true, \
                 false, a header value, or a table",
            ),
            ("[app]\nrouter = \"pages\"\n", "gio.toml:2: invalid `app.router`: unknown variant `pages`"),
            ("[images]\nformats = [\"gif\"]\n", "gio.toml:2: invalid `images.formats[0]`: unknown variant `gif`"),
            ("[compression]\nmin_size_bytes = 70000\n", "gio.toml:2: invalid `compression.min_size_bytes`"),
            ("[cache]\nmemory_max_entries = 0\n", "gio.toml:2: invalid `cache.memory_max_entries`"),
            ("[dev]\nwatch_ignore = [\"../shared/**\"]\n", "gio.toml:2: invalid `dev.watch_ignore`: invalid watch_ignore pattern"),
            ("\n\n[[rate_limits]]\nper_ip = 1\n", "gio.toml:3: invalid `rate_limits[0]`: missing field `path`"),
        ] {
            let text = error_text(body);
            assert!(text.starts_with(expected), "{body:?}\n got: {text}\nwant: {expected}");
        }
    }

    #[test]
    fn cache_disk_path_must_be_a_directory_inside_the_project() {
        for bad in [".", "./", "", "../cache", "/var/cache/gio", ".gio/../.."] {
            let text = error_text(&format!("[cache]\ndisk_path = {bad:?}\n"));
            assert!(text.contains("invalid `cache.disk_path`"), "{bad}: {text}");
        }
        let config = parse("[cache]\ndisk_path = \"./tmp/pages\"\n").unwrap();
        assert_eq!(config.cache.disk_path, "./tmp/pages");
    }

    #[test]
    fn cache_dir_may_not_overlap_app_or_public() {
        let root = unique_temp_path("cache_placement");
        std::fs::create_dir_all(root.join("app/blog")).unwrap();
        std::fs::create_dir_all(root.join("public")).unwrap();
        let config = |disk_path: &str| {
            parse(&format!("[cache]\ndisk_path = {disk_path:?}\n"))
                .unwrap()
                .cache
                .disk_dir(&root, None)
        };
        let check = |cache_dir: &std::path::Path| {
            check_cache_dir_placement(cache_dir, &root.join("app"), &root.join("public"))
        };
        for (disk_path, relation) in [
            ("app", "is the app/ directory"),
            ("app/cache", "is inside the app/ directory"),
            ("./app/blog/x", "is inside the app/ directory"),
            ("public", "is the public/ directory"),
            ("public/_cache/pages", "is inside the public/ directory"),
        ] {
            let error = check(&config(disk_path)).unwrap_err();
            assert!(error.contains(relation), "{disk_path}: {error}");
            assert!(error.contains(".gio/cache/pages"), "{disk_path}: {error}");
        }
        // GIO_CACHE_DIR is held to the same rule, compared resolved; a
        // parent of app/ contains it.
        let error = check(&root.join("public/../app/blog/x")).unwrap_err();
        assert!(error.contains("is inside the app/ directory"), "{error}");
        let error = check(&root).unwrap_err();
        assert!(error.contains("contains the app/ directory"), "{error}");
        // Directories of their own pass, existing or not, hidden or not.
        for disk_path in [".gio/cache/pages", "cachedir/pages", "data", "application"] {
            assert_eq!(check(&config(disk_path)), Ok(()), "{disk_path}");
        }
        assert_eq!(check(&std::env::temp_dir().join("gio-cache")), Ok(()));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bracketed_ipv6_hosts_are_accepted() {
        for host in ["[::]", "[::1]"] {
            let config = parse(&format!("[server]\nhost = {host:?}\n")).unwrap();
            assert!(
                config.bind_addr().parse::<std::net::SocketAddr>().is_ok(),
                "{}",
                config.bind_addr()
            );
        }
    }

    #[test]
    fn partial_server_table_defaults_host_and_port() {
        let config = parse("[server]\nhttp2 = false\n").unwrap();
        assert_eq!(config.bind_addr(), "0.0.0.0:3000");
        assert!(!config.server.http2);
        assert_eq!(config.port_source, "default");
        let config = parse("[server]\nport = 8080\n").unwrap();
        assert_eq!(config.bind_addr(), "0.0.0.0:8080");
        assert_eq!(config.port_source, "gio.toml");
        let config = parse("[server]\nhost = \"127.0.0.1\"\n").unwrap();
        assert_eq!(config.bind_addr(), "127.0.0.1:3000");
        let missing = GioConfig::load_from_path(&unique_temp_path("no_server.toml")).unwrap();
        assert_eq!(missing.port_source, "default");
    }

    #[test]
    fn port_env_precedence_is_gio_port_then_port_then_gio_toml() {
        let mut config = parse("[server]\nport = 4321\n").unwrap();
        config
            .apply_listen_overrides(None, None, Some("8080"))
            .unwrap();
        assert_eq!(config.server.port, 8080, "PORT beats gio.toml");
        assert_eq!(config.port_source, "PORT");

        let mut config = parse("[server]\nport = 4321\n").unwrap();
        config
            .apply_listen_overrides(None, Some("9090"), Some("8080"))
            .unwrap();
        assert_eq!(config.server.port, 9090, "GIO_PORT beats PORT");
        assert_eq!(config.port_source, "GIO_PORT");

        // An empty GIO_PORT falls through to PORT.
        let mut config = parse("").unwrap();
        config
            .apply_listen_overrides(None, Some(""), Some("5000"))
            .unwrap();
        assert_eq!(config.bind_addr(), "0.0.0.0:5000");
    }

    #[test]
    fn compression_section_parses_with_defaults() {
        let defaults = parse("").unwrap().compression;
        assert_eq!(defaults, CompressionConfig::default());
        assert!(defaults.enabled && defaults.prefer_brotli);
        assert_eq!(defaults.min_size_bytes, 1024);
        let config =
            parse("[compression]\nenabled = false\nmin_size_bytes = 256\nprefer_brotli = false\n")
                .unwrap()
                .compression;
        assert_eq!(
            config,
            CompressionConfig {
                enabled: false,
                min_size_bytes: 256,
                prefer_brotli: false,
            }
        );
    }

    #[test]
    fn prefetch_section_sets_the_budgets() {
        let defaults = parse("").unwrap().prefetch.budgets();
        assert_eq!((defaults.max_in_flight, defaults.max_per_second), (5, 20));
        let budgets = parse("[prefetch]\nmax_concurrent = 2\nmax_per_second = 7\n")
            .unwrap()
            .prefetch
            .budgets();
        assert_eq!((budgets.max_in_flight, budgets.max_per_second), (2, 7));
        // The budgets the server builds really enforce them.
        let enforced = giojs_prefetch::PrefetchBudgets::new(budgets);
        let ip: std::net::IpAddr = "192.0.2.1".parse().unwrap();
        assert!(enforced.try_acquire(ip));
        assert!(enforced.try_acquire(ip));
        assert!(
            !enforced.try_acquire(ip),
            "a third concurrent prefetch is over budget"
        );
    }

    #[test]
    fn cache_section_sets_entries_and_directory() {
        let root = std::path::Path::new("/srv/site");
        let defaults = parse("").unwrap().cache;
        assert_eq!(defaults.memory_max_entries.get(), 1000);
        assert_eq!(defaults.disk_max_bytes, 512 * 1024 * 1024);
        assert_eq!(defaults.disk_dir(root, None), root.join(".gio/cache/pages"));

        let cache = parse(
            "[cache]\nmemory_max_entries = 50\ndisk_path = \"var/pages\"\ndisk_max_bytes = 0\n",
        )
        .unwrap()
        .cache;
        assert_eq!(cache.memory_max_entries.get(), 50);
        assert_eq!(cache.disk_max_bytes, 0);
        assert_eq!(cache.disk_dir(root, None), root.join("var/pages"));
        // GIO_CACHE_DIR still wins; an empty one does not.
        assert_eq!(
            cache.disk_dir(root, Some("/tmp/gio-pages")),
            std::path::PathBuf::from("/tmp/gio-pages")
        );
        assert_eq!(cache.disk_dir(root, Some("")), root.join("var/pages"));
    }

    #[test]
    fn image_formats_parse_in_preference_order() {
        use giojs_image::processor::OutputFormat;
        let defaults = parse("").unwrap().images;
        assert_eq!(
            defaults.negotiated_formats(),
            vec![OutputFormat::Avif, OutputFormat::WebP]
        );
        let images = parse("[images]\nformats = [\"webp\", \"image/avif\", \"webp\"]\n")
            .unwrap()
            .images;
        assert_eq!(
            images.negotiated_formats(),
            vec![OutputFormat::WebP, OutputFormat::Avif]
        );
        let none = parse("[images]\nformats = []\n").unwrap().images;
        assert!(none.negotiated_formats().is_empty());
        assert_eq!(
            OutputFormat::negotiate("image/avif,image/webp", &images.negotiated_formats()),
            OutputFormat::WebP
        );
    }

    #[test]
    fn dev_watch_ignore_parses_globs() {
        let config = parse("[dev]\nwatch_ignore = [\"data/**\", \"*.db\"]\n").unwrap();
        let root = std::path::Path::new("/proj");
        assert!(config
            .dev
            .watch_ignore
            .is_ignored_under(root, std::path::Path::new("/proj/data/db.json")));
        assert!(config
            .dev
            .watch_ignore
            .is_ignored_under(root, std::path::Path::new("/proj/lib/app.db")));
        assert!(parse("").unwrap().dev.watch_ignore.is_empty());
    }

    /// The example configs people copy must keep loading.
    #[test]
    fn every_gio_toml_in_the_repository_loads() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for file in [
            "gio.toml",
            "packages/giojs-cli/templates/default/gio.toml",
            "packages/giojs-cli/templates/default-js/gio.toml",
            "examples/basic-app/gio.toml",
            "examples/auth-demo/gio.toml",
            "docs-site/gio.toml",
            "tests/integration/fixture/gio.toml",
        ] {
            let path = repo.join(file);
            assert!(path.exists(), "{file} is missing");
            if let Err(error) = GioConfig::load_from_path(&path) {
                panic!("{file}: {error}");
            }
        }
    }

    fn render_schema() -> String {
        let generator = schemars::generate::SchemaSettings::draft07().into_generator();
        let schema = generator.into_root_schema_for::<GioConfig>();
        let mut json = serde_json::to_string_pretty(&schema).expect("schema serializes");
        json.push('\n');
        json
    }

    /// packages/giojs/gio.schema.json is generated from these types. To
    /// refresh it: GIO_UPDATE_SCHEMA=1 cargo test -p giojs-server json_schema
    #[test]
    fn committed_json_schema_is_up_to_date() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/giojs/gio.schema.json");
        let rendered = render_schema();
        if std::env::var_os("GIO_UPDATE_SCHEMA").is_some() {
            std::fs::write(&path, &rendered).expect("write gio.schema.json");
            return;
        }
        // A Windows checkout may have converted line endings.
        let committed = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            committed == rendered,
            "packages/giojs/gio.schema.json is out of date - run: \
             GIO_UPDATE_SCHEMA=1 cargo test -p giojs-server json_schema"
        );
    }

    #[test]
    fn sections_list_matches_the_config_struct() {
        let schema: serde_json::Value = serde_json::from_str(&render_schema()).unwrap();
        let properties = schema["properties"].as_object().expect("properties");
        let mut fields: Vec<&str> = properties.keys().map(String::as_str).collect();
        let mut sections: Vec<&str> = SECTIONS.iter().map(|(name, _)| *name).collect();
        fields.sort_unstable();
        sections.sort_unstable();
        assert_eq!(fields, sections);
        for (name, array) in SECTIONS {
            assert_eq!(
                properties[*name]["type"] == "array",
                *array,
                "{name}: array-of-tables flag"
            );
        }
        // Editors flag unknown top-level keys, except x-* tables.
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema["patternProperties"]["^x-"].is_object());
        for (key, _) in RETIRED_KEYS {
            let (section, field) = key.split_once('.').unwrap();
            let section_schema = &properties[section];
            let reference = section_schema["$ref"].as_str().unwrap_or_default();
            let definition = reference.rsplit('/').next().unwrap_or_default();
            assert!(
                schema["definitions"][definition]["properties"][field].is_null(),
                "retired key {key} must not be accepted"
            );
        }
    }

    /// What serde accepts, read off its own error for an unknown key or
    /// variant ("expected one of `a`, `b`" - aliases included).
    fn serde_spellings(message: &str) -> std::collections::BTreeSet<String> {
        let (_, expected) = message
            .split_once("expected")
            .unwrap_or_else(|| panic!("no list of expected spellings in: {message}"));
        expected
            .split('`')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    fn struct_spellings<T: serde::de::DeserializeOwned + std::fmt::Debug>(
    ) -> std::collections::BTreeSet<String> {
        serde_spellings(toml::from_str::<T>("__probe__ = 0").unwrap_err().message())
    }

    fn enum_spellings<T: serde::de::DeserializeOwned + std::fmt::Debug>(
    ) -> std::collections::BTreeSet<String> {
        #[derive(Debug, Deserialize)]
        struct Probe<T> {
            #[allow(dead_code)]
            value: T,
        }
        serde_spellings(
            toml::from_str::<Probe<T>>("value = \"__probe__\"")
                .unwrap_err()
                .message(),
        )
    }

    /// Editors validate with the schema, so it must accept every key and
    /// value spelling the parser does - serde aliases included, which
    /// schemars leaves out (`requireCookie`, `image/webp`) - and no more.
    #[test]
    fn schema_accepts_every_spelling_the_parser_does() {
        use crate::client_identity::ProxyHeaders;
        use crate::rules::{GuardRule, HeaderRule, RedirectRule, RewriteRule};
        let schema: serde_json::Value = serde_json::from_str(&render_schema()).unwrap();
        let definitions = schema["definitions"].as_object().expect("definitions");
        for (name, definition) in definitions {
            let parser = match name.as_str() {
                "AppConfig" => struct_spellings::<AppConfig>(),
                "CacheConfig" => struct_spellings::<CacheConfig>(),
                "CompressionConfig" => struct_spellings::<CompressionConfig>(),
                "CsrfConfig" => struct_spellings::<CsrfConfig>(),
                "CssConfig" => struct_spellings::<CssConfig>(),
                "DevConfig" => struct_spellings::<DevConfig>(),
                "FontEntry" => struct_spellings::<FontEntry>(),
                "GuardRule" => struct_spellings::<GuardRule>(),
                "HeaderRule" => struct_spellings::<HeaderRule>(),
                "HstsPolicy" => struct_spellings::<HstsPolicy>(),
                "I18nConfig" => struct_spellings::<I18nConfig>(),
                "ImageConfig" => struct_spellings::<ImageConfig>(),
                "LoggingConfig" => struct_spellings::<LoggingConfig>(),
                "MetricsConfig" => struct_spellings::<MetricsConfig>(),
                "PrefetchConfig" => struct_spellings::<PrefetchConfig>(),
                "RateLimitEntry" => struct_spellings::<RateLimitEntry>(),
                "RedirectRule" => struct_spellings::<RedirectRule>(),
                "RemotePattern" => struct_spellings::<RemotePattern>(),
                "RevalidateConfig" => struct_spellings::<RevalidateConfig>(),
                "RewriteRule" => struct_spellings::<RewriteRule>(),
                "SecurityConfig" => struct_spellings::<SecurityConfig>(),
                "ServerConfig" => struct_spellings::<ServerConfig>(),
                "TlsConfig" => struct_spellings::<TlsConfig>(),
                "WebSocketSecurityConfig" => struct_spellings::<WebSocketSecurityConfig>(),
                "WebsocketConfig" => struct_spellings::<WebsocketConfig>(),
                "AppRouter" => enum_spellings::<AppRouter>(),
                "ImageFormat" => enum_spellings::<ImageFormat>(),
                "LogFormat" => enum_spellings::<LogFormat>(),
                "ProxyHeaders" => enum_spellings::<ProxyHeaders>(),
                // true | false | a string | HstsPolicy, checked above.
                "HstsSetting" => continue,
                // A count or "auto": WorkersSetting's hand-written parser,
                // covered by the worker-count tests.
                "WorkersSchema" | "WorkersAuto" => continue,
                other => {
                    panic!("{other}: list it here so its schema is checked against the parser")
                }
            };
            let in_schema: std::collections::BTreeSet<String> =
                if let Some(properties) = definition["properties"].as_object() {
                    assert_eq!(definition["additionalProperties"], false, "{name}");
                    properties.keys().cloned().collect()
                } else if let Some(values) = definition["enum"].as_array() {
                    values
                        .iter()
                        .map(|v| v.as_str().unwrap().to_string())
                        .collect()
                } else {
                    definition["oneOf"]
                        .as_array()
                        .unwrap_or_else(|| panic!("{name}: neither properties nor values"))
                        .iter()
                        .map(|variant| variant["const"].as_str().unwrap().to_string())
                        .collect()
                };
            assert_eq!(in_schema, parser, "{name}");
        }
        // Both spellings of one key are a duplicate to serde: the schema
        // takes either, exactly one when the key is required.
        let guard = &definitions["GuardRule"];
        assert_eq!(guard["required"], serde_json::json!(["path"]));
        assert_eq!(
            guard["allOf"][2]["oneOf"],
            serde_json::json!([{ "required": ["redirect_to"] }, { "required": ["redirectTo"] }])
        );
        for alias_spelled in [
            "[[guards]]\npath = \"/a/*rest\"\nrequireCookie = \"s\"\nredirectTo = \"/\"\n",
            "[[guards]]\npath = \"/a/*rest\"\nrequireSession = true\nredirectTo = \"/\"\n",
            "[images]\nformats = [\"image/webp\", \"image/avif\"]\n",
        ] {
            parse(alias_spelled).unwrap_or_else(|error| panic!("{alias_spelled:?}: {error}"));
        }
        assert!(error_text(
            "[[guards]]\npath = \"/a/*rest\"\nrequire_cookie = \"s\"\nredirect_to = \"/\"\nredirectTo = \"/\"\n"
        )
        .contains("duplicate field"));
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
