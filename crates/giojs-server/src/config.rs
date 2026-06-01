use serde::Deserialize;

#[derive(Debug, Deserialize, Clone, Default)]
pub struct MetricsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub ip_allowlist: Vec<String>,
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
}

fn default_allowed_widths() -> Vec<u32> {
    vec![
        16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
    ]
}

fn default_image_quality() -> u8 {
    75
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            allowed_widths: default_allowed_widths(),
            quality: default_image_quality(),
            remote_patterns: Vec::new(),
        }
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
    #[serde(default)]
    pub tls: TlsConfig,
}

fn default_http2() -> bool {
    true
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

        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        toml::from_str(&raw).unwrap_or_default()
    }

    /// Absolute path to the project root directory (parent of GIO_APP_DIR or CWD).
    pub fn project_root() -> std::path::PathBuf {
        std::env::var("GIO_APP_DIR")
            .ok()
            .and_then(|app_dir| {
                std::path::Path::new(&app_dir)
                    .parent()
                    .map(|p| p.to_path_buf())
            })
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.server.host, self.server.port)
    }
}
