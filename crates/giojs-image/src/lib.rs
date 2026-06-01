//! giojs-image/src/lib.rs
//!
//! On-demand image optimization: resize, format conversion, two-layer cache.
//! Route: GET /_gio/image?src=&w=&q=&f=
//! All CPU work is spawn_blocking. Source validation enforces remotePatterns + path traversal.

pub mod cache;
pub mod processor;

use bytes::Bytes;
use cache::ImageCache;
use processor::{process_image, ImageParams, OutputFormat};
use serde::Deserialize;
use std::path::PathBuf;
use thiserror::Error;
use tracing::info;

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
}

impl ImageHandler {
    pub fn new(config: ImageConfig, disk_dir: PathBuf, public_dir: PathBuf) -> Self {
        let cache = ImageCache::new(200 * 1024 * 1024, disk_dir);
        Self {
            config,
            cache,
            public_dir,
        }
    }

    /// Returns `(data, format, cache_hit)`.
    pub async fn handle(
        &self,
        query: ImageQuery,
        accept: Option<&str>,
    ) -> Result<(Bytes, OutputFormat, bool), ImageError> {
        let src = query.src.as_deref().ok_or(ImageError::MissingSrc)?;
        let quality = query.q.unwrap_or(self.config.quality);
        let width = match query.w {
            Some(w) if !self.config.allowed_widths.contains(&w) => {
                return Err(ImageError::InvalidWidth(w));
            }
            other => other,
        };
        let forced_format = query.f.as_deref().and_then(OutputFormat::parse);
        let format =
            forced_format.unwrap_or_else(|| OutputFormat::from_accept(accept.unwrap_or("")));

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
        let result = tokio::task::spawn_blocking(move || process_image(source_bytes, &params))
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
            self.validate_remote(src)?;
            return reqwest::get(src)
                .await
                .map_err(|e| ImageError::FetchFailed(e.to_string()))?
                .bytes()
                .await
                .map_err(|e| ImageError::FetchFailed(e.to_string()));
        }
        let local_path = self.validate_local_path(src)?;
        tokio::fs::read(&local_path)
            .await
            .map(Bytes::from)
            .map_err(|_| ImageError::NotFound)
    }

    fn validate_remote(&self, src: &str) -> Result<(), ImageError> {
        let (scheme, host) = extract_scheme_host(src)
            .ok_or_else(|| ImageError::SourceNotAllowed(src.to_string()))?;
        let allowed = self
            .config
            .remote_patterns
            .iter()
            .any(|p| p.protocol == scheme && hostname_matches(&p.hostname, host));
        if !allowed {
            return Err(ImageError::SourceNotAllowed(src.to_string()));
        }
        Ok(())
    }

    fn validate_local_path(&self, src: &str) -> Result<PathBuf, ImageError> {
        let requested = self.public_dir.join(src.trim_start_matches('/'));
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

fn extract_scheme_host(url: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next()?;
    Some((scheme, host))
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
