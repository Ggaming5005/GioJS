//! giojs-cache/src/key.rs
//!
//! SHA256-based cache key builder. Keys are collision-resistant hex strings
//! derived from the request method, path, and query string.
//! Vary-header support is deferred to Phase 3.

use sha2::{Digest, Sha256};

/// Build a cache key from request components.
///
/// NUL bytes delimit fields so `/posts?id=1` and `/posts?id=` + `1` cannot collide.
pub fn build_cache_key(method: &str, path: &str, query: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update(b"\0");
    hasher.update(path.as_bytes());
    hasher.update(b"\0");
    hasher.update(query.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_inputs_produce_same_key() {
        let a = build_cache_key("GET", "/posts/42", "");
        let b = build_cache_key("GET", "/posts/42", "");
        assert_eq!(a, b);
    }

    #[test]
    fn different_paths_produce_different_keys() {
        let a = build_cache_key("GET", "/posts/42", "");
        let b = build_cache_key("GET", "/posts/43", "");
        assert_ne!(a, b);
    }

    #[test]
    fn query_string_is_included_in_key() {
        let a = build_cache_key("GET", "/posts", "page=1");
        let b = build_cache_key("GET", "/posts", "page=2");
        assert_ne!(a, b);
    }

    #[test]
    fn method_is_included_in_key() {
        let a = build_cache_key("GET", "/posts", "");
        let b = build_cache_key("POST", "/posts", "");
        assert_ne!(a, b);
    }

    #[test]
    fn path_and_query_boundary_is_unambiguous() {
        // /posts?id=1 vs /posts?id= + suffix 1 must not collide
        let a = build_cache_key("GET", "/posts", "id=1");
        let b = build_cache_key("GET", "/posts", "id=");
        assert_ne!(a, b);
    }

    #[test]
    fn key_is_lowercase_hex() {
        let key = build_cache_key("GET", "/", "");
        assert!(key
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_eq!(key.len(), 64); // SHA256 = 32 bytes = 64 hex chars
    }
}
