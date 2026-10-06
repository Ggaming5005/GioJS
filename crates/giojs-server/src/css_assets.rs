//! giojs-server/src/css_assets.rs
//!
//! Cache headers for stylesheets served at stable, unhashed URLs: app CSS
//! pre-transformed at startup (`/globals.css`) and the generated font CSS
//! (`/_gio/fonts/fonts.css`). Their content changes between deploys while the
//! URL does not, so they must revalidate on every use instead of being cached
//! as immutable - otherwise browsers keep the previous deploy's CSS for a
//! year. App CSS carries a strong ETag computed once when the cache is filled,
//! making the revalidation a bodiless 304.

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use dashmap::DashMap;
use sha2::{Digest, Sha256};

/// Unhashed URL: always revalidate (cheap with the ETag / Last-Modified).
pub const REVALIDATE_CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

/// Content-addressed or never-rewritten files only.
pub const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// URL path (`/globals.css`) → transformed stylesheet.
pub type CssCache = DashMap<String, CssAsset>;

/// One transformed stylesheet plus its validator, built together so a
/// response can never pair new bytes with an old ETag (or vice versa).
pub struct CssAsset {
    pub code: Bytes,
    etag: HeaderValue,
}

impl CssAsset {
    pub fn new(code: Bytes) -> Self {
        let etag =
            HeaderValue::from_str(&strong_etag(&code)).expect("hex digest is a valid header value");
        Self { code, etag }
    }

    #[cfg(test)]
    pub fn etag(&self) -> &str {
        self.etag.to_str().unwrap_or_default()
    }
}

/// Strong validator: the first 128 bits of SHA-256 over the served bytes,
/// stable across restarts and across instances serving the same build.
fn strong_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("\"{hex}\"")
}

/// If-None-Match evaluation (RFC 9110 13.1.2): weak comparison, `*` matches
/// any current representation, lists are comma-separated.
fn if_none_match_matches(request_headers: &HeaderMap, etag: &HeaderValue) -> bool {
    let Ok(etag) = etag.to_str() else {
        return false;
    };
    request_headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| {
            candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
        })
}

/// 304 when the client's copy is current, otherwise the full stylesheet.
pub fn css_response(asset: &CssAsset, request_headers: &HeaderMap) -> Response {
    let cache_control = HeaderValue::from_static(REVALIDATE_CACHE_CONTROL);
    if if_none_match_matches(request_headers, &asset.etag) {
        let mut resp = StatusCode::NOT_MODIFIED.into_response();
        let headers = resp.headers_mut();
        headers.insert(header::ETAG, asset.etag.clone());
        headers.insert(header::CACHE_CONTROL, cache_control);
        return resp;
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "text/css; charset=utf-8")
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::ETAG, asset.etag.clone())
        .body(Body::from(asset.code.clone()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Cache-Control for `/_gio/fonts/*`, chosen by request path so 304s carry
/// the same policy as 200s. `fonts.css` is regenerated from gio.toml on every
/// start; the `.woff2` files are written once and never rewritten in place.
pub fn font_cache_control(request_path: &str) -> HeaderValue {
    if request_path.ends_with(".css") {
        HeaderValue::from_static(REVALIDATE_CACHE_CONTROL)
    } else {
        HeaderValue::from_static(IMMUTABLE_CACHE_CONTROL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_inm(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn etag_is_strong_quoted_and_content_derived() {
        let a = CssAsset::new(Bytes::from_static(b"body{color:red}"));
        let b = CssAsset::new(Bytes::from_static(b"body{color:red}"));
        let c = CssAsset::new(Bytes::from_static(b"body{color:blue}"));
        assert!(a.etag().starts_with('"') && a.etag().ends_with('"'));
        assert!(!a.etag().starts_with("W/"));
        assert_eq!(a.etag().len(), 34);
        assert_eq!(a.etag(), b.etag());
        assert_ne!(a.etag(), c.etag());
    }

    #[test]
    fn full_response_revalidates_and_carries_etag() {
        let asset = CssAsset::new(Bytes::from_static(b"a{}"));
        let resp = css_response(&asset, &HeaderMap::new());
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()[header::CACHE_CONTROL],
            REVALIDATE_CACHE_CONTROL
        );
        assert!(!resp.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable"));
        assert_eq!(resp.headers()[header::ETAG], asset.etag());
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
    }

    #[test]
    fn matching_if_none_match_yields_bodiless_304() {
        let asset = CssAsset::new(Bytes::from_static(b"a{}"));
        let resp = css_response(&asset, &headers_with_inm(asset.etag()));
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(resp.headers()[header::ETAG], asset.etag());
        assert_eq!(
            resp.headers()[header::CACHE_CONTROL],
            REVALIDATE_CACHE_CONTROL
        );
        assert!(resp.headers().get(header::CONTENT_TYPE).is_none());
    }

    #[test]
    fn if_none_match_accepts_lists_weak_tags_and_wildcard() {
        let asset = CssAsset::new(Bytes::from_static(b"a{}"));
        let list = format!("\"other\", {}", asset.etag());
        assert!(if_none_match_matches(&headers_with_inm(&list), &asset.etag));
        let weak = format!("W/{}", asset.etag());
        assert!(if_none_match_matches(&headers_with_inm(&weak), &asset.etag));
        assert!(if_none_match_matches(&headers_with_inm("*"), &asset.etag));
    }

    #[test]
    fn stale_or_missing_validator_gets_the_full_body() {
        let old = CssAsset::new(Bytes::from_static(b"old{}"));
        let new = CssAsset::new(Bytes::from_static(b"new{}"));
        let resp = css_response(&new, &headers_with_inm(old.etag()));
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!if_none_match_matches(&HeaderMap::new(), &new.etag));
    }

    #[test]
    fn font_css_revalidates_while_font_files_stay_immutable() {
        assert_eq!(font_cache_control("/fonts.css"), REVALIDATE_CACHE_CONTROL);
        assert_eq!(
            font_cache_control("/inter-400-normal.woff2"),
            IMMUTABLE_CACHE_CONTROL
        );
    }
}
