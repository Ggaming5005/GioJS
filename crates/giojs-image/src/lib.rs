//! giojs-image/src/lib.rs
//!
//! On-demand image optimization: resize, format conversion, two-layer cache.
//! Route: GET /_gio/image?src=&w=&q=&f=
//! All CPU work is spawn_blocking. Source validation enforces remotePatterns +
//! path traversal. Remote fetches never follow redirects and are size-capped.

pub mod cache;
pub mod processor;

use bytes::{Bytes, BytesMut};
use cache::ImageCache;
use processor::{process_image_with_limits, DecodeLimits, ImageParams, OutputFormat};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;
use tracing::{info, warn};
use url::Url;

const DEFAULT_MAX_REMOTE_BYTES: u64 = 20 * 1024 * 1024;
const REMOTE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Default whole-download deadline for a remote source (gio.toml `[images]
/// remote_timeout_secs`).
pub const DEFAULT_REMOTE_TIMEOUT: Duration = Duration::from_secs(30);

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
    #[serde(default = "default_quality")]
    pub quality: u8,
    #[serde(default)]
    pub remote_patterns: Vec<RemotePattern>,
}

fn default_allowed_widths() -> Vec<u32> {
    vec![
        16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
    ]
}

fn default_quality() -> u8 {
    75
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            allowed_widths: default_allowed_widths(),
            quality: default_quality(),
            remote_patterns: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ImageError {
    #[error("invalid width {0}: not in allowed list")]
    InvalidWidth(u32),
    #[error("invalid quality {0}: must be 1-100")]
    InvalidQuality(u8),
    #[error("redirect blocked for remote source: {0}")]
    RedirectBlocked(String),
    #[error("remote source exceeds size limit of {0} bytes")]
    TooLarge(u64),
    #[error("src is required")]
    MissingSrc,
    #[error("source not allowed: {0}")]
    SourceNotAllowed(String),
    #[error("path traversal detected")]
    PathTraversal,
    #[error("source not found")]
    NotFound,
    #[error("fetch failed: {0}")]
    FetchFailed(String),
    #[error("processing failed: {0}")]
    ProcessFailed(String),
    #[error("cache write failed: {0}")]
    Cache(String),
}

#[derive(Debug, Deserialize)]
pub struct ImageQuery {
    pub src: Option<String>,
    pub w: Option<u32>,
    pub q: Option<u8>,
    pub f: Option<String>,
}

pub struct ImageHandler {
    config: ImageConfig,
    cache: ImageCache,
    public_dir: PathBuf,
    /// None only if TLS backend init fails; remote fetches then error per-request.
    http_client: Option<reqwest::Client>,
    /// 0 = unlimited.
    max_remote_bytes: u64,
    /// Modern formats negotiated from Accept, in preference order.
    formats: Vec<OutputFormat>,
    decode_limits: DecodeLimits,
}

/// The client remote sources are fetched with; `timeout` bounds a whole
/// download (None: no deadline past the connect timeout).
fn remote_client(timeout: Option<Duration>) -> Option<reqwest::Client> {
    // Redirects are refused so an allowlisted host cannot bounce fetches to internal IPs.
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(REMOTE_CONNECT_TIMEOUT);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    match builder.build() {
        Ok(client) => Some(client),
        Err(e) => {
            warn!(error = %e, "image HTTP client init failed; remote sources disabled");
            None
        }
    }
}

/// Whether a remote source of `len` bytes is over the `max` cap; 0 is
/// unlimited.
fn over_remote_cap(len: u64, max: u64) -> bool {
    max > 0 && len > max
}

impl ImageHandler {
    pub fn new(config: ImageConfig, disk_dir: PathBuf, public_dir: PathBuf) -> Self {
        let cache = ImageCache::new(200 * 1024 * 1024, disk_dir);
        Self {
            config,
            cache,
            public_dir,
            http_client: remote_client(Some(DEFAULT_REMOTE_TIMEOUT)),
            max_remote_bytes: DEFAULT_MAX_REMOTE_BYTES,
            formats: OutputFormat::MODERN.to_vec(),
            decode_limits: DecodeLimits::default(),
        }
    }

    /// Override the whole-download deadline for remote sources; None
    /// removes it. Builder-style, for startup wiring.
    pub fn with_remote_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.http_client = remote_client(timeout);
        self
    }

    /// Override the decoder's bounds. Builder-style, for startup wiring.
    pub fn with_decode_limits(mut self, decode_limits: DecodeLimits) -> Self {
        self.decode_limits = decode_limits;
        self
    }

    /// Restrict and order the modern formats (gio.toml `[images] formats`).
    /// AVIF and WebP only: JPEG/PNG are always available. Builder-style, for
    /// startup wiring.
    pub fn with_formats(mut self, formats: Vec<OutputFormat>) -> Self {
        self.formats = formats
            .into_iter()
            .filter(|format| OutputFormat::MODERN.contains(format))
            .collect();
        self
    }

    /// Override the remote download size cap (bytes; 0 = unlimited).
    /// Builder-style, for startup wiring.
    pub fn with_max_remote_bytes(mut self, max_remote_bytes: u64) -> Self {
        self.max_remote_bytes = max_remote_bytes;
        self
    }

    /// Override the disk cache size cap (bytes). Builder-style, for startup wiring.
    pub fn with_disk_max_bytes(mut self, disk_max_bytes: u64) -> Self {
        self.cache.set_disk_max_bytes(disk_max_bytes);
        self
    }

    /// Returns `(data, format, cache_hit)`.
    pub async fn handle(
        &self,
        query: ImageQuery,
        accept: Option<&str>,
    ) -> Result<(Bytes, OutputFormat, bool), ImageError> {
        let src = query.src.as_deref().ok_or(ImageError::MissingSrc)?;
        let quality = match query.q {
            Some(q) if !(1..=100).contains(&q) => return Err(ImageError::InvalidQuality(q)),
            Some(q) => q,
            None => self.config.quality.clamp(1, 100),
        };
        let width = match query.w {
            Some(w) if !self.config.allowed_widths.contains(&w) => {
                return Err(ImageError::InvalidWidth(w));
            }
            other => other,
        };
        // `f=` cannot pick a format the config left out (AVIF is left out
        // to save encode CPU); it falls back to negotiation instead.
        let forced_format = query
            .f
            .as_deref()
            .and_then(OutputFormat::parse)
            .filter(|format| {
                !OutputFormat::MODERN.contains(format) || self.formats.contains(format)
            });
        let format = forced_format
            .unwrap_or_else(|| OutputFormat::negotiate(accept.unwrap_or(""), &self.formats));

        let key = ImageCache::cache_key(src, width, quality, format.extension());
        if let Some(cached) = self.cache.get(&key, format.extension()).await {
            return Ok((cached, format, true));
        }

        let source_bytes = self.fetch_source(src).await?;
        let params = ImageParams {
            width,
            quality,
            format,
        };
        let decode_limits = self.decode_limits;
        let result = tokio::task::spawn_blocking(move || {
            process_image_with_limits(source_bytes, &params, decode_limits)
        })
        .await
        .map_err(|_| ImageError::ProcessFailed("spawn_blocking join error".into()))?
        .map_err(|e| ImageError::ProcessFailed(e.to_string()))?;

        self.cache
            .put(&key, format.extension(), result.data.clone())
            .await
            .map_err(|e| ImageError::Cache(e.to_string()))?;

        info!(src = %src, width = ?width, format = ?format, "image processed");
        Ok((result.data, format, false))
    }

    async fn fetch_source(&self, src: &str) -> Result<Bytes, ImageError> {
        if src.starts_with("http://") || src.starts_with("https://") {
            let validated = self.validate_remote(src)?;
            return self.fetch_remote(validated).await;
        }
        let local_path = self.validate_local_path(src)?;
        tokio::fs::read(&local_path)
            .await
            .map(Bytes::from)
            .map_err(|_| ImageError::NotFound)
    }

    async fn fetch_remote(&self, src: Url) -> Result<Bytes, ImageError> {
        let client = self
            .http_client
            .as_ref()
            .ok_or_else(|| ImageError::FetchFailed("HTTP client unavailable".into()))?;
        // The parsed Url from validate_remote is fetched as-is, so the host
        // that was allowlist-checked is exactly the host reqwest connects to.
        let mut response = client
            .get(src.clone())
            .send()
            .await
            .map_err(|e| ImageError::FetchFailed(e.to_string()))?;
        if response.status().is_redirection() {
            return Err(ImageError::RedirectBlocked(src.to_string()));
        }
        if !response.status().is_success() {
            return Err(ImageError::FetchFailed(format!(
                "upstream status {}",
                response.status()
            )));
        }
        // Content-Length lets us bail early, but the streamed count is authoritative.
        if let Some(declared_len) = response.content_length() {
            if over_remote_cap(declared_len, self.max_remote_bytes) {
                return Err(ImageError::TooLarge(self.max_remote_bytes));
            }
        }
        let mut body = BytesMut::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| ImageError::FetchFailed(e.to_string()))?
        {
            let len = (body.len() as u64).saturating_add(chunk.len() as u64);
            if over_remote_cap(len, self.max_remote_bytes) {
                return Err(ImageError::TooLarge(self.max_remote_bytes));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body.freeze())
    }

    fn validate_remote(&self, src: &str) -> Result<Url, ImageError> {
        // WHATWG parsing, not string splitting: `?`, `#`, `@`, and userinfo
        // tricks must resolve to the same host reqwest will actually fetch.
        let parsed = Url::parse(src).map_err(|_| ImageError::SourceNotAllowed(src.to_string()))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(ImageError::SourceNotAllowed(src.to_string()));
        }
        let is_domain = matches!(parsed.host(), Some(url::Host::Domain(_)));
        let host = parsed
            .host_str()
            .ok_or_else(|| ImageError::SourceNotAllowed(src.to_string()))?;
        let allowed = self.config.remote_patterns.iter().any(|p| {
            if p.protocol != parsed.scheme() {
                return false;
            }
            // IP-literal hosts never satisfy wildcard patterns - only an
            // exact allowlist entry can permit fetching an address directly.
            let host_ok = if is_domain {
                hostname_matches(&p.hostname, host)
            } else {
                p.hostname == host
            };
            host_ok
                && p.pathname
                    .as_deref()
                    .is_none_or(|pattern| pathname_matches(pattern, parsed.path()))
        });
        if !allowed {
            return Err(ImageError::SourceNotAllowed(src.to_string()));
        }
        Ok(parsed)
    }

    /// The public/ file a local `src` reads, as its path below public/
    /// (`/members/photo.png`, decoded, symlinks resolved) - the root URL the
    /// server also answers it at. `None` for a remote `src` or one that
    /// names no file inside public/. The server holds the file to the
    /// guards for its URLs before it lets the optimizer read it.
    pub fn local_file_path(&self, src: &str) -> Option<String> {
        if src.starts_with("http://") || src.starts_with("https://") {
            return None;
        }
        let file = self.validate_local_path(src).ok()?;
        let root = self.public_dir.canonicalize().ok()?;
        let relative = file.strip_prefix(&root).ok()?;
        let mut path = String::new();
        for component in relative.components() {
            path.push('/');
            path.push_str(component.as_os_str().to_str()?);
        }
        Some(path)
    }

    /// A local `src` is the URL the server serves the file at: public/ is
    /// served at the site root and under /public/*, so `/hero.png` and
    /// `/public/hero.png` both name public/hero.png.
    fn validate_local_path(&self, src: &str) -> Result<PathBuf, ImageError> {
        let relative = src.trim_start_matches('/');
        let relative = relative.strip_prefix("public/").unwrap_or(relative);
        let requested = self.public_dir.join(relative);
        let canonical = requested.canonicalize().map_err(|_| ImageError::NotFound)?;
        let root = self
            .public_dir
            .canonicalize()
            .map_err(|_| ImageError::NotFound)?;
        if !canonical.starts_with(&root) {
            return Err(ImageError::PathTraversal);
        }
        Ok(canonical)
    }
}

fn pathname_matches(pattern: &str, path: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => path.starts_with(prefix),
        None => path == pattern,
    }
}

fn hostname_matches(pattern: &str, host: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("**.") {
        host == suffix || host.ends_with(&format!(".{suffix}"))
    } else if let Some(suffix) = pattern.strip_prefix("*.") {
        host.ends_with(&format!(".{suffix}"))
            && !host[..host.len() - suffix.len() - 1].contains('.')
    } else {
        host == pattern
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handler_with_patterns(patterns: Vec<RemotePattern>) -> ImageHandler {
        ImageHandler::new(
            ImageConfig {
                remote_patterns: patterns,
                ..ImageConfig::default()
            },
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        )
    }

    fn pattern(protocol: &str, hostname: &str, pathname: Option<&str>) -> RemotePattern {
        RemotePattern {
            protocol: protocol.into(),
            hostname: hostname.into(),
            pathname: pathname.map(String::from),
        }
    }

    #[test]
    fn query_string_host_smuggling_is_rejected() {
        let handler = handler_with_patterns(vec![pattern("https", "**.cloudinary.com", None)]);
        let err = handler
            .validate_remote("https://169.254.169.254?x=.cloudinary.com")
            .unwrap_err();
        assert!(matches!(err, ImageError::SourceNotAllowed(_)));
    }

    #[test]
    fn fragment_host_smuggling_is_rejected() {
        let handler = handler_with_patterns(vec![pattern("https", "*.example.com", None)]);
        let err = handler
            .validate_remote("https://intranet#.example.com")
            .unwrap_err();
        assert!(matches!(err, ImageError::SourceNotAllowed(_)));
    }

    #[test]
    fn userinfo_host_smuggling_is_rejected() {
        let handler = handler_with_patterns(vec![pattern("https", "cdn.example.com", None)]);
        let err = handler
            .validate_remote("https://cdn.example.com@evil.test/img.png")
            .unwrap_err();
        assert!(matches!(err, ImageError::SourceNotAllowed(_)));
    }

    #[test]
    fn ip_literal_never_matches_wildcard_pattern() {
        let handler = handler_with_patterns(vec![pattern("https", "**.10.0.0.1", None)]);
        let err = handler
            .validate_remote("https://10.0.0.1/x.png")
            .unwrap_err();
        assert!(matches!(err, ImageError::SourceNotAllowed(_)));
    }

    #[test]
    fn exact_ip_allowlist_entry_is_honored() {
        let handler = handler_with_patterns(vec![pattern("http", "10.0.0.1", None)]);
        let validated = handler.validate_remote("http://10.0.0.1/x.png").unwrap();
        assert_eq!(validated.host_str(), Some("10.0.0.1"));
    }

    #[test]
    fn allowlisted_domain_with_query_is_accepted() {
        let handler = handler_with_patterns(vec![pattern("https", "**.cloudinary.com", None)]);
        let validated = handler
            .validate_remote("https://res.cloudinary.com/demo/image.jpg?v=2")
            .unwrap();
        assert_eq!(validated.host_str(), Some("res.cloudinary.com"));
    }

    #[test]
    fn pathname_restriction_is_enforced() {
        let handler =
            handler_with_patterns(vec![pattern("https", "cdn.example.com", Some("/public/*"))]);
        assert!(handler
            .validate_remote("https://cdn.example.com/public/a.png")
            .is_ok());
        let err = handler
            .validate_remote("https://cdn.example.com/private/a.png")
            .unwrap_err();
        assert!(matches!(err, ImageError::SourceNotAllowed(_)));
    }

    #[tokio::test]
    async fn invalid_width_returns_error() {
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        );
        let query = ImageQuery {
            src: Some("/test.jpg".into()),
            w: Some(999),
            q: None,
            f: None,
        };
        let err = handler.handle(query, None).await.unwrap_err();
        assert!(matches!(err, ImageError::InvalidWidth(999)));
    }

    #[tokio::test]
    async fn quality_zero_is_rejected() {
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        );
        let query = ImageQuery {
            src: Some("/test.jpg".into()),
            w: None,
            q: Some(0),
            f: None,
        };
        let err = handler.handle(query, None).await.unwrap_err();
        assert!(matches!(err, ImageError::InvalidQuality(0)));
    }

    #[tokio::test]
    async fn quality_above_100_is_rejected() {
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        );
        let query = ImageQuery {
            src: Some("/test.jpg".into()),
            w: None,
            q: Some(101),
            f: None,
        };
        let err = handler.handle(query, None).await.unwrap_err();
        assert!(matches!(err, ImageError::InvalidQuality(101)));
    }

    #[tokio::test]
    async fn missing_src_returns_error() {
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        );
        let query = ImageQuery {
            src: None,
            w: Some(640),
            q: None,
            f: None,
        };
        let err = handler.handle(query, None).await.unwrap_err();
        assert!(matches!(err, ImageError::MissingSrc));
    }

    #[tokio::test]
    async fn path_traversal_returns_error() {
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            std::env::temp_dir().join("gio_test_public"),
        );
        let query = ImageQuery {
            src: Some("/../../../etc/passwd".into()),
            w: None,
            q: None,
            f: None,
        };
        let err = handler.handle(query, None).await.unwrap_err();
        assert!(matches!(
            err,
            ImageError::PathTraversal | ImageError::NotFound
        ));
    }

    #[test]
    fn local_sources_resolve_like_the_public_urls_they_are_served_at() {
        let public =
            std::env::temp_dir().join(format!("gio_test_public_alias_{}", std::process::id()));
        std::fs::create_dir_all(public.join("public")).unwrap();
        std::fs::write(public.join("hero.png"), b"png").unwrap();
        std::fs::write(public.join("public").join("nested.png"), b"png").unwrap();
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            public.clone(),
        );
        let root = public.canonicalize().unwrap();
        let resolve = |src: &str| handler.validate_local_path(src);
        assert_eq!(resolve("/hero.png").unwrap(), root.join("hero.png"));
        assert_eq!(resolve("/public/hero.png").unwrap(), root.join("hero.png"));
        // /public/public/x is public/public/x, as the server serves it.
        assert_eq!(
            resolve("/public/public/nested.png").unwrap(),
            root.join("public").join("nested.png")
        );
        assert!(matches!(
            resolve("/public/../../etc/passwd"),
            Err(ImageError::NotFound | ImageError::PathTraversal)
        ));
        let _ = std::fs::remove_dir_all(&public);
    }

    #[test]
    fn local_file_path_names_the_file_below_public() {
        let public =
            std::env::temp_dir().join(format!("gio_test_local_file_{}", std::process::id()));
        std::fs::create_dir_all(public.join("members")).unwrap();
        std::fs::write(public.join("members").join("photo.png"), b"png").unwrap();
        let handler = ImageHandler::new(
            ImageConfig::default(),
            std::env::temp_dir().join("gio_test_image_cache"),
            public.clone(),
        );
        for src in [
            "/members/photo.png",
            "/public/members/photo.png",
            "members/photo.png",
            "//members//photo.png",
            "/members/./photo.png",
            "/members/../members/photo.png",
        ] {
            assert_eq!(
                handler.local_file_path(src).as_deref(),
                Some("/members/photo.png"),
                "{src}"
            );
        }
        assert_eq!(handler.local_file_path("/missing.png"), None);
        assert_eq!(
            handler.local_file_path("https://cdn.example/members/photo.png"),
            None
        );
        let _ = std::fs::remove_dir_all(&public);
    }

    #[tokio::test]
    async fn configured_formats_bound_negotiation_and_the_f_parameter() {
        let base = std::env::temp_dir().join(format!("gio_image_formats_{}", std::process::id()));
        let public = base.join("public");
        std::fs::create_dir_all(&public).unwrap();
        std::fs::create_dir_all(base.join("cache")).unwrap();
        let mut png = Vec::new();
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(public.join("dot.png"), png).unwrap();
        let handler = ImageHandler::new(ImageConfig::default(), base.join("cache"), public)
            .with_formats(vec![OutputFormat::WebP]);
        let query = |f: Option<&str>| ImageQuery {
            src: Some("/dot.png".into()),
            w: None,
            q: None,
            f: f.map(str::to_string),
        };
        let accept = Some("image/avif,image/webp,*/*");
        let (_, format, _) = handler.handle(query(None), accept).await.unwrap();
        assert_eq!(format, OutputFormat::WebP, "AVIF is not configured");
        let (_, format, _) = handler.handle(query(Some("avif")), accept).await.unwrap();
        assert_eq!(
            format,
            OutputFormat::WebP,
            "f= cannot force a left-out format"
        );
        let (_, format, _) = handler.handle(query(Some("png")), accept).await.unwrap();
        assert_eq!(format, OutputFormat::Png, "JPEG/PNG stay available");

        let jpeg_only = ImageHandler::new(
            ImageConfig::default(),
            base.join("cache"),
            base.join("public"),
        )
        .with_formats(Vec::new());
        let (_, format, _) = jpeg_only.handle(query(None), accept).await.unwrap();
        assert_eq!(format, OutputFormat::Jpeg);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn zero_max_remote_bytes_is_unlimited() {
        assert!(!over_remote_cap(u64::MAX, 0));
        assert!(!over_remote_cap(20, 20));
        assert!(over_remote_cap(21, 20));
    }

    #[test]
    fn hostname_matches_double_wildcard() {
        assert!(hostname_matches("**.cloudinary.com", "img.cloudinary.com"));
        assert!(hostname_matches("**.cloudinary.com", "a.b.cloudinary.com"));
        assert!(hostname_matches("**.cloudinary.com", "cloudinary.com"));
        assert!(!hostname_matches("**.cloudinary.com", "evil.com"));
    }

    #[test]
    fn hostname_matches_exact() {
        assert!(hostname_matches("cdn.example.com", "cdn.example.com"));
        assert!(!hostname_matches("cdn.example.com", "other.example.com"));
        assert!(!hostname_matches("cdn.example.com", "evil.cdn.example.com"));
    }

    #[test]
    fn hostname_matches_single_wildcard() {
        assert!(hostname_matches("*.example.com", "cdn.example.com"));
        assert!(!hostname_matches("*.example.com", "a.b.example.com"));
        assert!(!hostname_matches("*.example.com", "example.com"));
    }
}
