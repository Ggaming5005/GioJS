//! giojs-server/src/path_hygiene.rs
//!
//! One canonical spelling of a request path, shared by every security
//! matcher (rate limits, guards, redirects, rewrites, header rules).
//!
//! Neither hyper nor axum decodes or normalizes the path, and the Node router
//! compares segments verbatim while skipping empty ones - so `/api/login/`,
//! `//api/login` and `/api//login` all reach the `/api/login` handler. Rules
//! that compare the raw string can be sidestepped by any of those spellings.
//! The canonical form closes that gap:
//!
//! - percent-escapes of RFC 3986 unreserved characters are decoded and the
//!   hex digits of every other escape are uppercased (both are equivalences
//!   under RFC 3986 §6.2.2, so the URL keeps its meaning),
//! - repeated slashes collapse and a trailing slash is dropped (except root),
//! - `.` / `..` segments - raw or escaped - are rejected outright: the Node
//!   router would treat them as ordinary segments while every browser and
//!   proxy resolves them, so no single canonical form is safe for both,
//! - a `%` that does not start a valid escape is rejected too (as nginx,
//!   Apache and Go's net/http do): no decoding of such a path is canonical.
//!
//! The escape normalization is also applied to the URI forwarded to Node
//! (see `path_hygiene_middleware` in main.rs), so the string the rules matched
//! is exactly the string Node routes. Slashes are left as the client sent
//! them there: the Node router already ignores empty segments.
//!
//! That only holds because the escape normalization is idempotent: the
//! later middlewares canonicalize the forwarded (already normalized) path
//! again, and a second pass must not decode anything new. Every `%` left in
//! a normalized path starts an uppercase escape of a reserved byte, so it
//! is a fixed point. A stray `%` would break that - `/%%36C` would normalize
//! to `/%6C` and then decode to `/l` - which is why it is refused.

use std::borrow::Cow;

/// Why a path was refused before any matcher saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRejection {
    /// A `.` or `..` segment (possibly percent-encoded).
    DotSegment,
    /// A `%` not followed by two hex digits (`%zz`, `%6`, a trailing `%`).
    MalformedEscape,
}

/// The reserved namespace for Rust's own endpoints (`/_gio/health`, ...).
const GIO_NAMESPACE_SEGMENT: &str = "_gio";

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn hex_value(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// Decode escapes of unreserved characters and uppercase the hex digits of
/// the remaining escapes. A `%` that does not start a valid escape is
/// refused (see the module docs: it would make the result decodable again).
/// The result is a fixed point - normalizing it again changes nothing.
/// Borrows when nothing changes.
pub fn normalize_escapes(path: &str) -> Result<Cow<'_, str>, PathRejection> {
    let bytes = path.as_bytes();
    let Some(first_escape) = bytes.iter().position(|&b| b == b'%') else {
        return Ok(Cow::Borrowed(path));
    };
    let mut out = String::with_capacity(path.len());
    out.push_str(&path[..first_escape]);
    let mut changed = false;
    let mut index = first_escape;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            // Copy up to the next '%' in one go; slicing at ASCII '%'
            // positions always lands on a char boundary.
            let next = bytes[index..]
                .iter()
                .position(|&b| b == b'%')
                .map_or(bytes.len(), |offset| index + offset);
            out.push_str(&path[index..next]);
            index = next;
            continue;
        }
        let (Some(hi_digit), Some(lo_digit)) = (bytes.get(index + 1), bytes.get(index + 2)) else {
            return Err(PathRejection::MalformedEscape);
        };
        let (Some(hi), Some(lo)) = (hex_value(*hi_digit), hex_value(*lo_digit)) else {
            return Err(PathRejection::MalformedEscape);
        };
        let decoded = hi * 16 + lo;
        if is_unreserved(decoded) {
            out.push(decoded as char);
            changed = true;
        } else {
            changed |= hi_digit.is_ascii_lowercase() || lo_digit.is_ascii_lowercase();
            out.push('%');
            out.push(hi_digit.to_ascii_uppercase() as char);
            out.push(lo_digit.to_ascii_uppercase() as char);
        }
        index += 3;
    }
    Ok(if changed {
        Cow::Owned(out)
    } else {
        Cow::Borrowed(path)
    })
}

fn is_dot_segment(segment: &str) -> bool {
    segment == "." || segment == ".."
}

/// The canonical form every security matcher compares against. Borrows in the
/// common case of an already-clean path. Because `normalize_escapes` is a
/// fixed point, `canonical(normalize_escapes(p))` equals `canonical(p)`: the
/// middlewares behind `path_hygiene_middleware`, which canonicalize the
/// already-normalized forwarded path, see what the gate saw.
pub fn canonical(path: &str) -> Result<Cow<'_, str>, PathRejection> {
    let normalized = normalize_escapes(path)?;
    if normalized.split('/').any(is_dot_segment) {
        return Err(PathRejection::DotSegment);
    }
    let already_canonical = normalized.starts_with('/')
        && !normalized.contains("//")
        && (normalized.len() == 1 || !normalized.ends_with('/'));
    if already_canonical {
        return Ok(normalized);
    }
    let mut out = String::with_capacity(normalized.len());
    for segment in normalized.split('/').filter(|segment| !segment.is_empty()) {
        out.push('/');
        out.push_str(segment);
    }
    if out.is_empty() {
        out.push('/');
    }
    Ok(Cow::Owned(out))
}

/// True when `path` lies in the reserved `/_gio` namespace. Compares the first
/// non-empty segment, so it holds for raw spellings like `//_gio/x` as well.
/// Callers pass an escape-normalized path (`/%5Fgio` is not decoded here).
pub fn is_gio_namespace(path: &str) -> bool {
    path.split('/').find(|segment| !segment.is_empty()) == Some(GIO_NAMESPACE_SEGMENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(path: &str) -> String {
        canonical(path).expect("path is acceptable").into_owned()
    }

    // ── slash forms ──────────────────────────────────────────────────────────

    #[test]
    fn clean_paths_borrow_and_stay_unchanged() {
        for path in ["/", "/api/login", "/a/b/c", "/caf%C3%A9"] {
            assert!(matches!(canonical(path), Ok(Cow::Borrowed(p)) if p == path));
        }
    }

    #[test]
    fn trailing_slash_is_stripped_except_on_root() {
        assert_eq!(canon("/api/login/"), "/api/login");
        assert_eq!(canon("/api/login///"), "/api/login");
        assert_eq!(canon("/"), "/");
        assert_eq!(canon("//"), "/");
    }

    #[test]
    fn repeated_slashes_collapse_anywhere() {
        assert_eq!(canon("//api/login"), "/api/login");
        assert_eq!(canon("/api//login"), "/api/login");
        assert_eq!(canon("///api///login//"), "/api/login");
    }

    #[test]
    fn empty_and_relative_paths_become_absolute() {
        assert_eq!(canon(""), "/");
        assert_eq!(canon("api/login"), "/api/login");
    }

    // ── percent-encoding ─────────────────────────────────────────────────────

    #[test]
    fn unreserved_escapes_are_decoded() {
        assert_eq!(canon("/api/%6Cogin"), "/api/login");
        assert_eq!(canon("/%61dmin"), "/admin");
        assert_eq!(canon("/%41%5a%30%2D%5F%7E"), "/AZ0-_~");
        assert_eq!(canon("/%5Fgio/settings"), "/_gio/settings");
    }

    #[test]
    fn reserved_and_non_ascii_escapes_stay_encoded_with_uppercase_hex() {
        // %2F must stay encoded: decoding it would invent a segment boundary.
        assert_eq!(canon("/a%2fb"), "/a%2Fb");
        assert_eq!(canon("/caf%c3%a9"), "/caf%C3%A9");
        assert_eq!(canon("/100%25"), "/100%25");
        assert_eq!(canon("/q%3f"), "/q%3F");
    }

    #[test]
    fn malformed_escapes_are_rejected() {
        for path in [
            "/%zz",
            "/trailing%",
            "/short%6",
            "/%%61",
            "/%g1",
            "/%6g",
            "/%é",
            "/%6é",
            // A stray '%' in front of an escape: decoding the escape would
            // assemble a brand-new one ("%6C", "%2e") for the next pass.
            "/api/%%36Cogin",
            "/%%32e%%32e/admin",
            "/%5Fgio/%",
        ] {
            assert_eq!(
                canonical(path),
                Err(PathRejection::MalformedEscape),
                "{path} must be rejected"
            );
            assert_eq!(
                normalize_escapes(path),
                Err(PathRejection::MalformedEscape),
                "{path} must not be forwarded"
            );
        }
    }

    #[test]
    fn decoding_happens_once_not_recursively() {
        // %2561 is an escaped '%' followed by "61" - never "a".
        assert_eq!(canon("/%2561dmin"), "/%2561dmin");
        assert_eq!(canon("/%25%36%31"), "/%2561");
    }

    /// The forwarded path is `normalize_escapes(raw)`, and the rate-limit and
    /// rules middlewares canonicalize that again. They must land where the
    /// gate did - a second decoding pass would let them match a path Node
    /// never routes.
    #[test]
    fn canonical_of_forwarded_path_equals_canonical_of_raw() {
        for raw in [
            "/api/%%36Cogin",
            "/%%32e%%32e/admin",
            "/%%61",
            "/%2561dmin",
            "/%25%36%31",
            "/api/%6Cogin",
            "//%61pi//%6c%6f%67%69%6e/",
            "/caf%c3%a9",
            "/a%2fb",
        ] {
            match normalize_escapes(raw) {
                Ok(forwarded) => assert_eq!(canonical(&forwarded), canonical(raw), "{raw}"),
                Err(rejection) => assert_eq!(canonical(raw), Err(rejection), "{raw}"),
            }
        }
    }

    #[test]
    fn normalization_is_a_fixed_point_for_every_short_path() {
        // Every path of up to five characters over an alphabet that can
        // spell escapes of '%', '.', 'C', '6' and 'l' - including stray '%'s
        // in front of them.
        const ALPHABET: &[u8] = b"%2356Cex/.";
        let mut path = String::new();
        for len in 0..=5u32 {
            for mut index in 0..ALPHABET.len().pow(len) {
                path.clear();
                for _ in 0..len {
                    path.push(ALPHABET[index % ALPHABET.len()] as char);
                    index /= ALPHABET.len();
                }
                let canonical_path = canonical(&path);
                let normalized = match normalize_escapes(&path) {
                    Ok(normalized) => normalized,
                    Err(rejection) => {
                        assert_eq!(canonical_path, Err(rejection), "{path}");
                        continue;
                    }
                };
                assert_eq!(
                    normalize_escapes(&normalized).as_deref(),
                    Ok(&*normalized),
                    "{path}"
                );
                assert_eq!(canonical(&normalized), canonical_path, "{path}");
                if let Ok(canonical_path) = canonical_path {
                    assert_eq!(
                        canonical(&canonical_path).as_deref(),
                        Ok(&*canonical_path),
                        "{path}"
                    );
                }
            }
        }
    }

    #[test]
    fn multibyte_utf8_passes_through() {
        assert_eq!(canon("/café//x/"), "/café/x");
        assert_eq!(normalize_escapes("/é%61é").unwrap(), "/éaé");
    }

    #[test]
    fn normalize_escapes_leaves_slashes_alone() {
        assert_eq!(
            normalize_escapes("//api//%6Cogin/").unwrap(),
            "//api//login/"
        );
        assert!(matches!(
            normalize_escapes("/plain//x/"),
            Ok(Cow::Borrowed(_))
        ));
        assert!(matches!(
            normalize_escapes("/already%2F"),
            Ok(Cow::Borrowed(_))
        ));
    }

    // ── dot segments ─────────────────────────────────────────────────────────

    #[test]
    fn dot_segments_are_rejected_raw_and_encoded() {
        for path in [
            "/.",
            "/..",
            "/admin/../x",
            "/x/./admin",
            "/admin/..",
            "/%2e%2e/admin",
            "/%2E./admin",
            "/.%2e",
            "/a/%2e/b",
        ] {
            assert_eq!(
                canonical(path),
                Err(PathRejection::DotSegment),
                "{path} must be rejected"
            );
        }
    }

    #[test]
    fn dots_inside_segments_are_ordinary_characters() {
        assert_eq!(canon("/file.txt"), "/file.txt");
        assert_eq!(canon("/..."), "/...");
        assert_eq!(canon("/.well-known/x"), "/.well-known/x");
        assert_eq!(canon("/a..b"), "/a..b");
    }

    // ── /_gio namespace ──────────────────────────────────────────────────────

    #[test]
    fn gio_namespace_matches_the_first_segment_only() {
        assert!(is_gio_namespace("/_gio"));
        assert!(is_gio_namespace("/_gio/"));
        assert!(is_gio_namespace("/_gio/settings"));
        assert!(is_gio_namespace("//_gio//health"));
        assert!(!is_gio_namespace("/_giox/settings"));
        assert!(!is_gio_namespace("/acme/_gio"));
        assert!(!is_gio_namespace("/"));
    }
}
