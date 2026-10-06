//! giojs-server/src/revalidate.rs
//!
//! On-demand revalidation: purge cached pages by tag or path, from the
//! worker (`revalidateTag` / `revalidatePath` in @gio.js/core, delivered as
//! IPC `revalidate` frames) or from outside (`POST /_gio/revalidate`, e.g. a
//! CMS webhook). Purge semantics: matching entries are dropped from memory
//! and disk, so the next request is a miss and renders fresh - nobody is
//! served the old page while a refresh runs.
//!
//! The endpoint is off unless a token is configured (GIO_REVALIDATE_TOKEN,
//! or `[revalidate] token` in gio.toml - the environment wins). It is
//! bearer-authenticated, never cookie-authenticated, so the cross-site
//! checks for app routes do not apply to it; failed attempts are limited
//! per client instead.
//!
//! The cache is per server instance: with several instances, every one of
//! them must be called.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use giojs_cache::{path_tag, PageCache, PathMatch};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::path_hygiene;

pub const TOKEN_ENV: &str = "GIO_REVALIDATE_TOKEN";
/// Same floor as GIO_SESSION_SECRET: the endpoint is reachable by anyone,
/// so the token is the only thing standing between it and a purge flood.
pub const MIN_TOKEN_BYTES: usize = 32;
/// Mirrors packages/giojs-core/src/revalidate.ts.
pub const MAX_TAGS: usize = 64;
pub const MAX_TAG_BYTES: usize = 256;
pub const MAX_PATHS: usize = 64;
const MAX_PATH_BYTES: usize = 2048;
/// `_gio:` tags are the server's own (the implicit path tag).
const RESERVED_TAG_PREFIX: &str = "_gio:";
/// Bodies are a few tags or paths; anything bigger is not a real request.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

/// Failed attempts a client may make per window before it is refused
/// outright (429) - without its token even being checked.
const FAILURE_LIMIT: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// Clients tracked at once. Past this, an untracked client that fails is
/// refused like a blocked one: a flood from many addresses must not buy
/// unlimited guesses by evicting its own records.
const MAX_TRACKED_CLIENTS: usize = 4096;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TokenError {
    #[error(
        "the revalidation token ({source_name}) is {len} bytes; at least {MIN_TOKEN_BYTES} are required"
    )]
    TooShort {
        source_name: &'static str,
        len: usize,
    },
}

/// The endpoint token: GIO_REVALIDATE_TOKEN when set and non-empty, else
/// gio.toml's `[revalidate] token`. None disables the endpoint.
pub fn resolve_token(
    env_token: Option<&str>,
    config_token: &str,
) -> Result<Option<String>, TokenError> {
    let (token, source_name) = match env_token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(token) => (token, TOKEN_ENV),
        None => (config_token.trim(), "[revalidate] token"),
    };
    if token.is_empty() {
        return Ok(None);
    }
    if token.len() < MIN_TOKEN_BYTES {
        return Err(TokenError::TooShort {
            source_name,
            len: token.len(),
        });
    }
    Ok(Some(token.to_string()))
}

/// `POST /_gio/revalidate` body, and the payload of a worker `revalidate`
/// frame. Unknown fields are refused: a misspelled `tag` must be a 400, not
/// a silent no-op that leaves stale pages up.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevalidateRequest {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    /// Purge each path and everything below it.
    #[serde(default)]
    pub prefix: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TargetError {
    #[error("nothing to revalidate: send at least one tag or path")]
    Empty,
    #[error("too many {what} (at most {max})")]
    TooMany { what: &'static str, max: usize },
    #[error("invalid tag {0:?}: tags are 1-{MAX_TAG_BYTES} bytes without control characters, and must not start with \"_gio:\"")]
    InvalidTag(String),
    #[error("invalid path {0:?}: paths start with \"/\", are at most {MAX_PATH_BYTES} bytes, and contain no dot segments or malformed escapes")]
    InvalidPath(String),
}

/// Validated purge targets, paths already in the form entries are tagged with.
#[derive(Debug, PartialEq, Eq)]
pub struct Targets {
    tags: Vec<String>,
    paths: Vec<String>,
    prefix: bool,
}

impl Targets {
    /// Validate a request. `locales` are the configured i18n locales: the
    /// server caches pages under their locale-free path (one entry per
    /// locale), so a leading locale segment is dropped and the purge
    /// reaches every locale of the page.
    pub fn validate(request: RevalidateRequest, locales: &[String]) -> Result<Self, TargetError> {
        if request.tags.is_empty() && request.paths.is_empty() {
            return Err(TargetError::Empty);
        }
        if request.tags.len() > MAX_TAGS {
            return Err(TargetError::TooMany {
                what: "tags",
                max: MAX_TAGS,
            });
        }
        if request.paths.len() > MAX_PATHS {
            return Err(TargetError::TooMany {
                what: "paths",
                max: MAX_PATHS,
            });
        }
        let mut tags = Vec::with_capacity(request.tags.len());
        for tag in request.tags {
            if !is_valid_tag(&tag) {
                return Err(TargetError::InvalidTag(tag));
            }
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        let mut paths = Vec::with_capacity(request.paths.len());
        for raw in request.paths {
            let Some(path) = normalize_path(&raw, locales) else {
                return Err(TargetError::InvalidPath(raw));
            };
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        Ok(Targets {
            tags,
            paths,
            prefix: request.prefix,
        })
    }

    /// Purge every matching entry. Returns how many were purged.
    pub async fn apply(&self, cache: &PageCache) -> usize {
        let kind = if self.prefix {
            PathMatch::Prefix
        } else {
            PathMatch::Exact
        };
        cache.invalidate_tags(&self.tags).await + cache.invalidate_paths(&self.paths, kind).await
    }
}

fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= MAX_TAG_BYTES
        && !tag.chars().any(char::is_control)
        && !tag.starts_with(RESERVED_TAG_PREFIX)
}

/// The canonical, locale-free form of a requested path, or None when it is
/// not a path a page could be cached under. A query or fragment is dropped:
/// a path purge covers every query string of the page.
fn normalize_path(raw: &str, locales: &[String]) -> Option<String> {
    let path = raw.split(['?', '#']).next().unwrap_or_default();
    if !path.starts_with('/') || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return None;
    }
    let canonical = path_hygiene::canonical(path).ok()?.into_owned();
    let path = strip_locale(&canonical, locales).to_string();
    (!path_hygiene::is_gio_namespace(&path)).then_some(path)
}

/// Drop a leading configured-locale segment, the way the i18n layer does
/// before a request reaches the cache.
fn strip_locale<'a>(path: &'a str, locales: &[String]) -> &'a str {
    let rest = &path[1..];
    let (segment, tail) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    if !segment.is_empty() && locales.iter().any(|locale| locale == segment) {
        if tail.is_empty() {
            "/"
        } else {
            tail
        }
    } else {
        path
    }
}

/// The tags a cache entry for `path` is stored with: the worker's declared
/// tags (re-checked here - they are user data that only passed the worker's
/// own validation) plus the implicit path tag every page carries, so path
/// purges reach it.
pub fn entry_tags(path: &str, declared: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::with_capacity(declared.len().min(MAX_TAGS) + 1);
    for tag in declared {
        if tags.len() == MAX_TAGS {
            break;
        }
        if is_valid_tag(tag) && !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    let canonical =
        path_hygiene::canonical(path).map_or_else(|_| path.to_string(), |p| p.into_owned());
    tags.push(path_tag(&canonical));
    tags
}

/// Constant-time token check. Both sides are hashed first, so neither the
/// content nor the length of the configured token leaks through timing.
pub fn token_matches(authorization: Option<&str>, token: &str) -> bool {
    let Some(presented) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    let presented = Sha256::digest(presented.as_bytes());
    let expected = Sha256::digest(token.as_bytes());
    presented
        .iter()
        .zip(expected.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Per-client failed-attempt counter (fixed window). IPv6 clients are
/// counted per /64, like rate limits: one host controls the whole range.
#[derive(Debug, Default)]
pub struct AuthFailures {
    clients: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl AuthFailures {
    /// Some(retry-after) while `ip` has used up its failures this window.
    pub fn blocked(&self, ip: IpAddr, now: Instant) -> Option<Duration> {
        let clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        let (count, started) = clients.get(&client_key(ip))?;
        let elapsed = now.saturating_duration_since(*started);
        (*count >= FAILURE_LIMIT && elapsed < FAILURE_WINDOW).then(|| FAILURE_WINDOW - elapsed)
    }

    /// Count a failed attempt. Returns false when the client cannot be
    /// tracked (the table is full of live records) - treat it as blocked.
    pub fn record(&self, ip: IpAddr, now: Instant) -> bool {
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        let key = client_key(ip);
        if !clients.contains_key(&key) && clients.len() >= MAX_TRACKED_CLIENTS {
            clients
                .retain(|_, (_, started)| now.saturating_duration_since(*started) < FAILURE_WINDOW);
            if clients.len() >= MAX_TRACKED_CLIENTS {
                return false;
            }
        }
        let record = clients.entry(key).or_insert((0, now));
        if now.saturating_duration_since(record.1) >= FAILURE_WINDOW {
            *record = (0, now);
        }
        record.0 += 1;
        true
    }
}

fn client_key(ip: IpAddr) -> IpAddr {
    let IpAddr::V6(v6) = ip else {
        return ip;
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return IpAddr::V4(v4);
    }
    let [a, b, c, d, ..] = v6.segments();
    IpAddr::V6(Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
}

/// The endpoint's configuration and state, handed to its handler.
#[derive(Debug)]
pub struct Endpoint {
    pub token: String,
    pub failures: AuthFailures,
}

/// What a purge targeted, for log lines.
pub fn summary(targets: &Targets) -> String {
    let mut parts = Vec::new();
    if !targets.tags.is_empty() {
        parts.push(format!("tags={}", targets.tags.join(",")));
    }
    if !targets.paths.is_empty() {
        parts.push(format!(
            "{}={}",
            if targets.prefix { "prefixes" } else { "paths" },
            targets.paths.join(",")
        ));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tags: &[&str], paths: &[&str], prefix: bool) -> RevalidateRequest {
        RevalidateRequest {
            tags: tags.iter().map(|t| t.to_string()).collect(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            prefix,
        }
    }

    fn locales() -> Vec<String> {
        vec!["en".into(), "fr".into()]
    }

    #[test]
    fn env_token_wins_over_config_and_short_tokens_are_refused() {
        let long = "x".repeat(MIN_TOKEN_BYTES);
        let other = "y".repeat(MIN_TOKEN_BYTES);
        assert_eq!(resolve_token(None, ""), Ok(None));
        assert_eq!(resolve_token(Some(""), ""), Ok(None));
        assert_eq!(resolve_token(None, &long), Ok(Some(long.clone())));
        assert_eq!(resolve_token(Some(&other), &long), Ok(Some(other.clone())));
        assert_eq!(
            resolve_token(Some("  "), &long),
            Ok(Some(long.clone())),
            "a blank env var does not disable the configured token"
        );
        assert_eq!(
            resolve_token(Some("short"), &long),
            Err(TokenError::TooShort {
                source_name: TOKEN_ENV,
                len: 5
            })
        );
        assert!(matches!(
            resolve_token(None, "short"),
            Err(TokenError::TooShort { .. })
        ));
    }

    #[test]
    fn token_matching_requires_the_exact_bearer_value() {
        let token = "t".repeat(40);
        assert!(token_matches(Some(&format!("Bearer {token}")), &token));
        assert!(!token_matches(Some(&format!("Bearer {token}x")), &token));
        assert!(!token_matches(Some(&format!("bearer {token}")), &token));
        assert!(
            !token_matches(Some(&token), &token),
            "the scheme is required"
        );
        assert!(!token_matches(Some("Bearer "), &token));
        assert!(!token_matches(None, &token));
    }

    #[test]
    fn targets_need_something_to_purge() {
        assert_eq!(
            Targets::validate(request(&[], &[], false), &[]),
            Err(TargetError::Empty)
        );
    }

    #[test]
    fn tags_are_validated_and_deduplicated() {
        let targets =
            Targets::validate(request(&["posts", "posts", "post:1"], &[], false), &[]).unwrap();
        assert_eq!(targets.tags, vec!["posts", "post:1"]);
        for bad in ["", "a\nb", "_gio:path:/x"] {
            assert_eq!(
                Targets::validate(request(&[bad], &[], false), &[]),
                Err(TargetError::InvalidTag(bad.to_string()))
            );
        }
        let long = "t".repeat(MAX_TAG_BYTES + 1);
        assert!(Targets::validate(request(&[&long], &[], false), &[]).is_err());
        let many: Vec<String> = (0..=MAX_TAGS).map(|i| format!("t{i}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(matches!(
            Targets::validate(request(&many, &[], false), &[]),
            Err(TargetError::TooMany { what: "tags", .. })
        ));
    }

    #[test]
    fn paths_are_canonicalized_and_lose_query_and_locale() {
        let targets = Targets::validate(
            request(
                &[],
                &[
                    "/blog/",
                    "//blog",
                    "/fr/about?x=1",
                    "/en",
                    "/caf%65",
                    "/frank",
                ],
                false,
            ),
            &locales(),
        )
        .unwrap();
        assert_eq!(
            targets.paths,
            vec!["/blog", "/about", "/", "/cafe", "/frank"]
        );
        for bad in ["blog", "/a/../b", "/%zz", "/_gio/health", ""] {
            assert_eq!(
                Targets::validate(request(&[], &[bad], false), &locales()),
                Err(TargetError::InvalidPath(bad.to_string())),
                "{bad}"
            );
        }
    }

    #[test]
    fn unknown_body_fields_are_rejected() {
        assert!(serde_json::from_str::<RevalidateRequest>(r#"{"tag":"posts"}"#).is_err());
        let ok: RevalidateRequest =
            serde_json::from_str(r#"{"paths":["/blog"],"prefix":true}"#).unwrap();
        assert!(ok.prefix);
    }

    #[test]
    fn entry_tags_sanitize_worker_tags_and_add_the_path_tag() {
        let declared: Vec<String> = ["posts", "", "posts", "_gio:path:/evil", "post:1"]
            .iter()
            .map(|t| t.to_string())
            .collect();
        assert_eq!(
            entry_tags("/blog/1/", &declared),
            vec!["posts", "post:1", "_gio:path:/blog/1"]
        );
        let flood: Vec<String> = (0..100).map(|i| format!("t{i}")).collect();
        let tags = entry_tags("/", &flood);
        assert_eq!(tags.len(), MAX_TAGS + 1, "worker tags are capped");
        assert_eq!(tags.last().unwrap(), "_gio:path:/");
    }

    #[tokio::test]
    async fn apply_purges_by_tag_and_by_path() {
        let dir = std::env::temp_dir().join(format!("giojs-revalidate-{}", std::process::id()));
        let cache = PageCache::new(giojs_cache::CacheConfig {
            memory_max_entries: std::num::NonZeroUsize::new(10).unwrap(),
            disk_dir: dir.clone(),
            swr_multiplier: 10,
            disk_max_bytes: 0,
        });
        let entry = |path: &str, tags: &[&str]| giojs_cache::CacheEntry {
            html: bytes::Bytes::from_static(b"<p>x</p>"),
            status: 200,
            headers: HashMap::new(),
            created_at: std::time::SystemTime::now(),
            max_age_secs: 60,
            deployment_id: "d".into(),
            composed: false,
            tags: entry_tags(
                path,
                &tags.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
            ),
            ppr_shell: false,
        };
        cache
            .put("post", entry("/blog/1", &["posts"]))
            .await
            .unwrap();
        cache.put("about", entry("/about", &[])).await.unwrap();
        cache.put("blog", entry("/blog", &[])).await.unwrap();

        let by_tag =
            Targets::validate(request(&["posts"], &["/fr/about"], false), &locales()).unwrap();
        assert_eq!(by_tag.apply(&cache).await, 2);
        assert!(cache.get("blog", "d").await.is_some());

        let by_prefix = Targets::validate(request(&[], &["/blog"], true), &[]).unwrap();
        assert_eq!(by_prefix.apply(&cache).await, 1);
        assert!(cache.get("blog", "d").await.is_none());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn failures_block_a_client_for_the_rest_of_the_window() {
        let failures = AuthFailures::default();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let now = Instant::now();
        for _ in 0..FAILURE_LIMIT {
            assert!(failures.blocked(ip, now).is_none());
            assert!(failures.record(ip, now));
        }
        let retry = failures.blocked(ip, now).expect("blocked after the limit");
        assert_eq!(retry, FAILURE_WINDOW);
        assert!(
            failures
                .blocked("203.0.113.8".parse().unwrap(), now)
                .is_none(),
            "other clients are unaffected"
        );
        assert!(
            failures.blocked(ip, now + FAILURE_WINDOW).is_none(),
            "the block lifts when the window ends"
        );
        assert!(failures.record(ip, now + FAILURE_WINDOW));
        assert!(
            failures.blocked(ip, now + FAILURE_WINDOW).is_none(),
            "fresh window"
        );
    }

    #[test]
    fn ipv6_failures_count_per_slash_64() {
        let failures = AuthFailures::default();
        let now = Instant::now();
        for i in 0..FAILURE_LIMIT {
            let ip: IpAddr = format!("2001:db8:a:b::{:x}", i + 1).parse().unwrap();
            failures.record(ip, now);
        }
        assert!(failures
            .blocked("2001:db8:a:b::ffff".parse().unwrap(), now)
            .is_some());
        assert!(failures
            .blocked("2001:db8:a:c::1".parse().unwrap(), now)
            .is_none());
    }

    #[test]
    fn a_full_table_refuses_untracked_failing_clients() {
        let failures = AuthFailures::default();
        let now = Instant::now();
        for i in 0..MAX_TRACKED_CLIENTS {
            let ip = IpAddr::V4(std::net::Ipv4Addr::from(0x0a00_0000 + i as u32));
            assert!(failures.record(ip, now));
        }
        let newcomer: IpAddr = "198.51.100.1".parse().unwrap();
        assert!(!failures.record(newcomer, now));
        assert!(
            failures.record(newcomer, now + FAILURE_WINDOW),
            "expired records make room"
        );
    }
}
