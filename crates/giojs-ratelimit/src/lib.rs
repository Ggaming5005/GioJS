//! giojs-ratelimit/src/lib.rs
//!
//! Token-bucket rate limiter. Multiple rules are evaluated in specificity order
//! (longest matching path prefix wins). Per client by default; per (client,
//! header value) when `key_header` is configured - the client is always part
//! of the key so rotating header values cannot mint unlimited fresh buckets,
//! and each client is capped at a fixed number of distinct header-value
//! buckets. A client is an IPv4 address or an IPv6 /64.
//!
//! `check` expects the canonical request path (no repeated or trailing
//! slashes, unreserved escapes decoded) - the server's path_hygiene module
//! produces it, so every spelling the router treats alike shares a bucket.
//!
//! Lock-free hot path: no Mutex per request.

mod bucket;
mod store;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Arc;

use store::RateLimitStore;

pub use bucket::TokenBucket;

// Bounds bucket-key memory: only this many header-value bytes enter the key.
const MAX_KEY_HEADER_VALUE_BYTES: usize = 64;
/// Default distinct header-value buckets one client may create per rule
/// before falling back to the shared per-client bucket (defeats
/// header-rotation bucket minting). gio.toml `[[rate_limits]]
/// max_keys_per_client`.
pub const DEFAULT_MAX_KEYS_PER_CLIENT: u64 = 64;
/// Default cap on live buckets across all rules and clients (~10-20 MB).
/// Past it, refilled buckets are swept and then the least recently seen are
/// evicted, so source-address rotation cannot grow memory without bound.
/// gio.toml `[server] rate_limit_max_buckets`; 0 lifts the cap.
pub const DEFAULT_MAX_BUCKETS: usize = 100_000;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RateLimitRule {
    /// Which paths the rule covers, e.g. "/api/*rest" or "/api/auth/*". A
    /// trailing catch-all also covers the bare prefix ("/api/*rest" matches
    /// "/api"); without one the match is exact. See `PathPattern`.
    pub path_pattern: PathPattern,
    /// Maximum requests allowed per `window_seconds` per client.
    pub per_ip: u64,
    /// Duration of the sliding window in seconds.
    pub window_seconds: u64,
    /// Extra requests permitted as a burst above the steady-state rate.
    pub burst: u64,
    /// If set, rate-limit by (client IP, value of this header) pairs - e.g.
    /// "x-api-key" - instead of the client IP alone. The value is truncated to
    /// MAX_KEY_HEADER_VALUE_BYTES; once an IP has created
    /// `max_keys_per_client` distinct buckets for this rule, further values
    /// share the per-IP bucket. Absent header falls back to the IP.
    pub key_header: Option<String>,
    /// Distinct `key_header` buckets one client may hold for this rule
    /// (DEFAULT_MAX_KEYS_PER_CLIENT). 0 = unlimited: many API keys behind
    /// one NAT address, at the price of a client minting fresh budgets by
    /// rotating the header.
    pub max_keys_per_client: u64,
}

impl RateLimitRule {
    /// Requests a full bucket admits at once: `per_ip` plus `burst`.
    pub fn capacity(&self) -> u64 {
        self.per_ip.saturating_add(self.burst)
    }
}

pub enum RateLimitResult {
    Allowed {
        /// Whole tokens left in the bucket, never more than `limit`.
        remaining: u64,
        /// The matched rule's bucket capacity (`per_ip + burst`): the most a
        /// fresh client can send at once. 0 means no rule matched (skip
        /// headers).
        limit: u64,
    },
    Rejected {
        retry_after_secs: u64,
        limit: u64,
        rule_pattern: String,
    },
}

pub struct RateLimiter {
    store: Arc<RateLimitStore>,
    rules: Vec<RateLimitRule>,
}

// ── RateLimiter impl ──────────────────────────────────────────────────────────

impl RateLimiter {
    pub fn new(rules: Vec<RateLimitRule>) -> Self {
        Self::with_max_buckets(rules, DEFAULT_MAX_BUCKETS)
    }

    /// Like `new` with an explicit cap on live buckets (0 = no cap).
    pub fn with_max_buckets(mut rules: Vec<RateLimitRule>, max_buckets: usize) -> Self {
        for rule in &mut rules {
            // The server lowercases incoming header names; normalize once here
            // so a mixed-case key_header from gio.toml still matches.
            if let Some(header_name) = rule.key_header.as_mut() {
                *header_name = header_name.to_ascii_lowercase();
            }
        }
        Self {
            store: Arc::new(RateLimitStore::new(max_buckets)),
            rules,
        }
    }

    /// Check whether a request to `path` from `ip` (with `headers`) is allowed.
    /// Returns `Allowed` if no rule matches or the bucket has capacity.
    pub fn check(
        &self,
        path: &str,
        ip: IpAddr,
        headers: &HashMap<String, String>,
    ) -> RateLimitResult {
        self.check_paths(&[path], ip, headers)
    }

    /// Check a request that answers to more than one path - a public/ file
    /// served at the site root is also `/public/...`, and rules written for
    /// either URL must hold. The most specific rule for each path must admit
    /// the request; a rule matched through several paths is charged once, so
    /// a catch-all rule does not count the request twice. `Allowed` reports
    /// the tightest budget among the matched rules.
    pub fn check_paths(
        &self,
        paths: &[&str],
        ip: IpAddr,
        headers: &HashMap<String, String>,
    ) -> RateLimitResult {
        let mut matched: Vec<(usize, &RateLimitRule)> = Vec::with_capacity(paths.len());
        for path in paths {
            if let Some((rule_index, rule)) = self.find_rule(path) {
                if !matched.iter().any(|(seen, _)| *seen == rule_index) {
                    matched.push((rule_index, rule));
                }
            }
        }

        let mut tightest: Option<(u64, u64)> = None;
        for (rule_index, rule) in matched {
            match self.consume(rule_index, rule, ip, headers) {
                RateLimitResult::Allowed { remaining, limit } => {
                    if tightest.is_none_or(|(best, _)| remaining < best) {
                        tightest = Some((remaining, limit));
                    }
                }
                rejected @ RateLimitResult::Rejected { .. } => return rejected,
            }
        }
        match tightest {
            Some((remaining, limit)) => RateLimitResult::Allowed { remaining, limit },
            None => RateLimitResult::Allowed {
                remaining: u64::MAX,
                limit: 0,
            },
        }
    }

    /// Take one token from `rule`'s bucket for this client.
    fn consume(
        &self,
        rule_index: usize,
        rule: &RateLimitRule,
        ip: IpAddr,
        headers: &HashMap<String, String>,
    ) -> RateLimitResult {
        let bucket = self.bucket_for(rule_index, ip, rule, headers);

        // The limit a client sees is what its bucket holds when full, so
        // Limit - Remaining is the share of it used.
        let limit = rule.capacity();
        if bucket.try_consume() {
            RateLimitResult::Allowed {
                remaining: bucket.remaining_approx().min(limit),
                limit,
            }
        } else {
            let retry_after_secs = rule
                .window_seconds
                .checked_div(rule.per_ip)
                .unwrap_or(1)
                .max(1);
            RateLimitResult::Rejected {
                retry_after_secs,
                limit,
                rule_pattern: rule.path_pattern.to_string(),
            }
        }
    }

    /// Drop buckets that have refilled to capacity. Lossless (a recreated
    /// bucket starts full), so long windows keep their state however idle
    /// the client is. Call from a periodic background task.
    pub fn sweep(&self) {
        self.store.sweep();
    }

    /// Find the most-specific matching rule for `path` (see `Specificity`).
    /// Only identical patterns tie; the later one wins, as it always has
    /// (`max_by_key` returns the last of equal maxima).
    fn find_rule(&self, path: &str) -> Option<(usize, &RateLimitRule)> {
        self.rules
            .iter()
            .enumerate()
            .filter_map(|(index, rule)| {
                rule.path_pattern
                    .match_path(path)
                    .map(|specificity| (specificity, index, rule))
            })
            .max_by_key(|&(specificity, ..)| specificity)
            .map(|(_, index, rule)| (index, rule))
    }

    /// The bucket for the matched rule. Header-keyed rules always compound
    /// with the client so rotating the header cannot escape the client's
    /// budget; once the client saturates its distinct-key allowance the
    /// shared per-client bucket is used instead.
    fn bucket_for(
        &self,
        rule_index: usize,
        ip: IpAddr,
        rule: &RateLimitRule,
        headers: &HashMap<String, String>,
    ) -> Arc<bucket::TokenBucket> {
        // '|' cannot appear in a client key (IPv6 Display contains ':'), so
        // the header value being the final field makes every key unambiguous.
        let client = client_key(ip);
        let client_bucket_key = format!("{rule_index}|{client}");
        let header_value = rule
            .key_header
            .as_deref()
            .and_then(|header_name| headers.get(header_name));
        if let Some(value) = header_value {
            let compound_key = format!(
                "{client_bucket_key}|{}",
                bounded_prefix(value, MAX_KEY_HEADER_VALUE_BYTES)
            );
            if let Some(bucket) = self.store.get_or_create_in_group(
                &compound_key,
                &client_bucket_key,
                rule.max_keys_per_client,
                rule.per_ip,
                rule.window_seconds,
                rule.burst,
            ) {
                return bucket;
            }
        }
        self.store.get_or_create(
            &client_bucket_key,
            rule.per_ip,
            rule.window_seconds,
            rule.burst,
        )
    }
}

/// The identity a client is limited by. An IPv6 host routinely controls a
/// whole /64 (privacy addresses rotate inside it), so per-/128 keys let one
/// host mint unlimited fresh buckets; IPv6 clients are keyed by their /64.
/// IPv4-mapped IPv6 addresses (dual-stack listeners) stay per IPv4 address -
/// masking them to a /64 would put every IPv4 client in one bucket.
fn client_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let [a, b, c, d, ..] = v6.segments();
                format!("{}/64", Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
            }
        },
    }
}

// ── Path pattern matching ─────────────────────────────────────────────────────

/// Why a `[[rate_limits]] path` cannot be used. Startup refuses the config:
/// a rule that silently matches nothing leaves the path it was meant to
/// limit unlimited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternError {
    /// Does not start with `/` (`api/*`, `*`).
    NotAbsolute,
    /// A `*rest` catch-all followed by more segments (`/api/*rest/x`).
    CatchAllNotLast,
    /// A `*` anywhere but the end of the last segment (`/a*b`, `/**`).
    MisplacedWildcard,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PatternError::NotAbsolute => "must start with '/'",
            PatternError::CatchAllNotLast => "a catch-all (*rest) must be the last segment",
            PatternError::MisplacedWildcard => {
                "'*' may only end the pattern (/api/*rest, /api/* or /api*)"
            }
        })
    }
}

impl std::error::Error for PatternError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatternSegment {
    Literal(String),
    /// `:name`: any one segment.
    Param(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatternTail {
    /// The segments are the whole path.
    Exact,
    /// `/*rest` or `/*`: zero or more further segments, so `/api/*rest`
    /// covers `/api` too - the router serves "/api/" (canonically "/api")
    /// from the same handler as "/api".
    CatchAll(String),
    /// `/api*`: one more segment starting with the literal, then anything
    /// (`/api`, `/apiary`, `/api/x`).
    Prefix(String),
}

/// A parsed `[[rate_limits]] path`, in the syntax the other path rules use
/// (giojs-server rules.rs): literal segments, `:param` for one segment, and
/// a trailing `*rest` catch-all (`/*` is the same without a name). `/api*`,
/// a literal prefix of the last segment, stays from the original glob
/// syntax. Repeated and trailing slashes are dropped: requests are compared
/// in canonical form, so "/api/login/" must mean "/api/login" or it could
/// never match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathPattern {
    segments: Vec<PatternSegment>,
    tail: PatternTail,
}

impl PathPattern {
    pub fn parse(raw: &str) -> Result<Self, PatternError> {
        if !raw.starts_with('/') {
            return Err(PatternError::NotAbsolute);
        }
        let raw_segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
        let mut segments = Vec::with_capacity(raw_segments.len());
        let mut tail = PatternTail::Exact;
        for (index, raw_segment) in raw_segments.iter().enumerate() {
            let last = index + 1 == raw_segments.len();
            if let Some(name) = raw_segment.strip_prefix('*') {
                if !last {
                    return Err(PatternError::CatchAllNotLast);
                }
                if name.contains('*') {
                    return Err(PatternError::MisplacedWildcard);
                }
                tail = PatternTail::CatchAll(name.to_string());
            } else if let Some(prefix) = raw_segment.strip_suffix('*') {
                if !last || prefix.contains('*') {
                    return Err(PatternError::MisplacedWildcard);
                }
                tail = PatternTail::Prefix(prefix.to_string());
            } else if raw_segment.contains('*') {
                return Err(PatternError::MisplacedWildcard);
            } else if let Some(name) = raw_segment.strip_prefix(':') {
                segments.push(PatternSegment::Param(name.to_string()));
            } else {
                segments.push(PatternSegment::Literal((*raw_segment).to_string()));
            }
        }
        Ok(PathPattern { segments, tail })
    }

    /// Match the canonical `path`: how specific the match is, or `None`.
    fn match_path(&self, path: &str) -> Option<Specificity> {
        let mut rest = path.split('/').filter(|s| !s.is_empty());
        // Path bytes the segments covered, and the literal bytes among them
        // (a `:param` contributes only its separator).
        let mut covered = 0;
        let mut literal = 0;
        for segment in &self.segments {
            let head = rest.next()?;
            match segment {
                PatternSegment::Literal(text) if text != head => return None,
                PatternSegment::Literal(text) => literal += 1 + text.len(),
                PatternSegment::Param(_) => literal += 1,
            }
            covered += 1 + head.len();
        }
        match &self.tail {
            PatternTail::Exact => rest.next().is_none().then_some(Specificity {
                matched: path.len(),
                exact: true,
                literal,
            }),
            // The bare prefix is covered by the segments only, so that match
            // scores like an exact rule for it would, never higher.
            PatternTail::CatchAll(_) => Some(Specificity {
                matched: if rest.next().is_some() {
                    covered + 1
                } else {
                    covered
                },
                exact: false,
                literal: literal + 1,
            }),
            PatternTail::Prefix(prefix) => {
                rest.next()?
                    .starts_with(prefix.as_str())
                    .then_some(Specificity {
                        matched: covered + 1 + prefix.len(),
                        exact: false,
                        literal: literal + 1 + prefix.len(),
                    })
            }
        }
    }
}

/// The canonical spelling, which logs and metrics name the rule by.
impl std::fmt::Display for PathPattern {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for segment in &self.segments {
            match segment {
                PatternSegment::Literal(text) => write!(f, "/{text}")?,
                PatternSegment::Param(name) => write!(f, "/:{name}")?,
            }
        }
        match &self.tail {
            PatternTail::Exact if self.segments.is_empty() => f.write_str("/"),
            PatternTail::Exact => Ok(()),
            PatternTail::CatchAll(name) => write!(f, "/*{name}"),
            PatternTail::Prefix(prefix) => write!(f, "/{prefix}*"),
        }
    }
}

/// How specifically a pattern matched a path; the greatest wins. Fields
/// compare in declaration order:
///   1. `matched` - how much of the path the pattern covered before its
///      wildcard (the documented "longest prefix wins"),
///   2. `exact` - on equal coverage an exact pattern beats a wildcard, so an
///      exact "/auth" rule keeps "/auth" even though "/auth/*" covers the
///      bare "/auth" too,
///   3. `literal` - then the more literal text: on "/auth", "/auth/*" (only
///      "/auth" and below) beats the broader "/auth*" (also "/authors"),
///      and "/users/me" beats "/users/:id".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Specificity {
    matched: usize,
    exact: bool,
    literal: usize,
}

/// Longest prefix of `value` that fits in `max_bytes` on a char boundary.
fn bounded_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
    const OTHER: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));

    fn pattern(raw: &str) -> PathPattern {
        PathPattern::parse(raw).unwrap()
    }

    fn specificity(raw: &str, path: &str) -> Option<Specificity> {
        pattern(raw).match_path(path)
    }

    fn make_limiter(rules: Vec<RateLimitRule>) -> RateLimiter {
        RateLimiter::new(rules)
    }

    fn api_rule(per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: pattern("/api/*"),
            per_ip,
            window_seconds: 60,
            burst: 0,
            key_header: None,
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        }
    }

    fn api_auth_rule(per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: pattern("/api/auth/*"),
            per_ip,
            window_seconds: 60,
            burst: 0,
            key_header: None,
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        }
    }

    fn empty_headers() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn rule_matching_api_star() {
        let rl = make_limiter(vec![api_rule(100)]);
        let result = rl.check("/api/users", LOCAL, &empty_headers());
        assert!(matches!(result, RateLimitResult::Allowed { .. }));
    }

    #[test]
    fn more_specific_rule_wins_over_broader() {
        // /api/auth/* (per_ip=10) is more specific than /api/* (per_ip=100).
        // A request to /api/auth/login should consume from the 10-req bucket.
        let rl = make_limiter(vec![api_rule(100), api_auth_rule(10)]);

        // Exhaust the auth bucket (10 requests)
        for _ in 0..10 {
            let r = rl.check("/api/auth/login", LOCAL, &empty_headers());
            assert!(matches!(r, RateLimitResult::Allowed { .. }));
        }

        // 11th request to /api/auth/login must be rejected
        let r = rl.check("/api/auth/login", LOCAL, &empty_headers());
        assert!(matches!(r, RateLimitResult::Rejected { .. }));

        // But /api/users still has its own full bucket (different rule/key)
        let r = rl.check("/api/users", LOCAL, &empty_headers());
        assert!(matches!(r, RateLimitResult::Allowed { .. }));
    }

    #[test]
    fn no_matching_rule_allows() {
        let rl = make_limiter(vec![api_rule(1)]);
        let result = rl.check("/public/logo.png", LOCAL, &empty_headers());
        assert!(matches!(
            result,
            RateLimitResult::Allowed {
                remaining: u64::MAX,
                ..
            }
        ));
    }

    fn rule(path_pattern: &str, per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: pattern(path_pattern),
            per_ip,
            window_seconds: 3600,
            burst: 0,
            key_header: None,
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        }
    }

    #[test]
    fn every_path_of_a_request_must_pass_its_rule() {
        // /members/report.txt is also /public/members/report.txt: the
        // /public/* budget must hold for the root URL too, and both URLs
        // drain the same bucket.
        let rl = make_limiter(vec![rule("/public/members/*", 2)]);
        let paths = ["/members/report.txt", "/public/members/report.txt"];
        assert!(matches!(
            rl.check_paths(&paths, LOCAL, &empty_headers()),
            RateLimitResult::Allowed {
                remaining: 1,
                limit: 2
            }
        ));
        assert!(matches!(
            rl.check("/public/members/report.txt", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check_paths(&paths, LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn a_rule_matched_through_several_paths_is_charged_once() {
        let rl = make_limiter(vec![rule("/*", 2)]);
        let paths = ["/robots.txt", "/public/robots.txt"];
        for _ in 0..2 {
            assert!(matches!(
                rl.check_paths(&paths, LOCAL, &empty_headers()),
                RateLimitResult::Allowed { .. }
            ));
        }
        assert!(matches!(
            rl.check_paths(&paths, LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn the_tightest_matched_budget_is_reported() {
        let rl = make_limiter(vec![rule("/*", 100), rule("/public/*", 5)]);
        let paths = ["/robots.txt", "/public/robots.txt"];
        let RateLimitResult::Allowed { remaining, limit } =
            rl.check_paths(&paths, LOCAL, &empty_headers())
        else {
            panic!("first request must be allowed");
        };
        assert_eq!((remaining, limit), (4, 5));
        // Each distinct rule was charged: /* has 99 left before this one.
        let RateLimitResult::Allowed { remaining, .. } = rl.check("/page", LOCAL, &empty_headers())
        else {
            panic!("must be allowed");
        };
        assert_eq!(remaining, 98);
    }

    #[test]
    fn the_limit_is_the_bucket_capacity_burst_included() {
        // per_ip = 3 with burst = 20: a fresh client can send 23 at once, so
        // Remaining (22 after the first) must never exceed the Limit.
        let rl = make_limiter(vec![RateLimitRule {
            burst: 20,
            ..rule("/api/*", 3)
        }]);
        let RateLimitResult::Allowed { remaining, limit } =
            rl.check("/api/hello", LOCAL, &empty_headers())
        else {
            panic!("first request must be allowed");
        };
        assert_eq!((remaining, limit), (22, 23));
        for _ in 0..22 {
            let RateLimitResult::Allowed { remaining, limit } =
                rl.check("/api/hello", LOCAL, &empty_headers())
            else {
                panic!("the burst must be admitted");
            };
            assert!(remaining < limit);
        }
        assert!(matches!(
            rl.check("/api/hello", LOCAL, &empty_headers()),
            RateLimitResult::Rejected { limit: 23, .. }
        ));
    }

    fn keyed_rule(per_ip: u64, window_seconds: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: pattern("/api/*"),
            per_ip,
            window_seconds,
            burst: 0,
            key_header: Some("x-api-key".to_string()),
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        }
    }

    fn api_key_headers(value: &str) -> HashMap<String, String> {
        let mut headers = HashMap::new();
        headers.insert("x-api-key".to_string(), value.to_string());
        headers
    }

    #[test]
    fn key_header_buckets_are_scoped_per_ip_and_key() {
        let rl = make_limiter(vec![keyed_rule(2, 60)]);

        let headers_alice = api_key_headers("key-alice");
        let headers_bob = api_key_headers("key-bob");

        // Exhaust Alice's bucket (2 requests from same IP)
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_alice),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_alice),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_alice),
            RateLimitResult::Rejected { .. }
        ));

        // Same IP, different key - separate bucket
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_bob),
            RateLimitResult::Allowed { .. }
        ));

        // Different IP, same key - its own bucket (keys are compounded with IP)
        assert!(matches!(
            rl.check("/api/data", OTHER, &headers_alice),
            RateLimitResult::Allowed { .. }
        ));
    }

    #[test]
    fn rotating_header_values_cannot_mint_unbounded_buckets() {
        // per_ip=1, huge window → zero refill during the test.
        let rl = make_limiter(vec![keyed_rule(1, 3600)]);

        let mut allowed = 0usize;
        for i in 0..200 {
            let headers = api_key_headers(&format!("rotated-key-{i}"));
            if matches!(
                rl.check("/api/data", LOCAL, &headers),
                RateLimitResult::Allowed { .. }
            ) {
                allowed += 1;
            }
        }

        // 64 distinct buckets (1 token each) + 1 from the shared fallback bucket.
        let expected = (DEFAULT_MAX_KEYS_PER_CLIENT as usize) + 1;
        assert_eq!(
            allowed, expected,
            "header rotation must saturate at the per-IP distinct-key cap"
        );

        // A fresh IP is unaffected by the attacker's saturation.
        let headers = api_key_headers("legit-key");
        assert!(matches!(
            rl.check("/api/data", OTHER, &headers),
            RateLimitResult::Allowed { .. }
        ));
    }

    #[test]
    fn the_distinct_key_cap_is_per_rule_and_zero_lifts_it() {
        let capped = make_limiter(vec![RateLimitRule {
            max_keys_per_client: 3,
            ..keyed_rule(1, 3600)
        }]);
        let unlimited = make_limiter(vec![RateLimitRule {
            max_keys_per_client: 0,
            ..keyed_rule(1, 3600)
        }]);
        let allowed = |rl: &RateLimiter| {
            (0..200)
                .filter(|i| {
                    let headers = api_key_headers(&format!("gateway-key-{i}"));
                    matches!(
                        rl.check("/api/data", LOCAL, &headers),
                        RateLimitResult::Allowed { .. }
                    )
                })
                .count()
        };
        // 3 own buckets + the shared fallback's one token.
        assert_eq!(allowed(&capped), 4);
        // Every key behind the one address keeps a budget of its own.
        assert_eq!(allowed(&unlimited), 200);
    }

    #[test]
    fn oversized_header_values_share_one_bucket() {
        let rl = make_limiter(vec![keyed_rule(2, 3600)]);

        let shared_prefix = "p".repeat(MAX_KEY_HEADER_VALUE_BYTES);
        let headers_one = api_key_headers(&format!("{shared_prefix}-suffix-one"));
        let headers_two = api_key_headers(&format!("{shared_prefix}-suffix-two"));

        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_one),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_two),
            RateLimitResult::Allowed { .. }
        ));
        // Third request rejected: both values truncate to the same 64-byte key.
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_one),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn absent_key_header_falls_back_to_ip_bucket() {
        let rl = make_limiter(vec![keyed_rule(1, 3600)]);

        assert!(matches!(
            rl.check("/api/data", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn ipv6_ip_and_crafted_header_cannot_collide_with_another_client() {
        // With ':' as the key delimiter, (ip="2001:db8::1", header="2:3") and
        // (ip="2001:db8:0:1::", header="3") could both render as
        // "0:2001:db8:...:2:3". The '|' delimiter keeps their buckets separate.
        let rl = make_limiter(vec![keyed_rule(1, 3600)]);
        let attacker: IpAddr = "2001:db8::1".parse().unwrap();
        let victim: IpAddr = "2001:db8:0:1::".parse().unwrap();

        assert!(matches!(
            rl.check("/api/data", attacker, &api_key_headers("2:3")),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", attacker, &api_key_headers("2:3")),
            RateLimitResult::Rejected { .. }
        ));

        // Victim is a different (ip, header) pair - must have its own bucket.
        assert!(matches!(
            rl.check("/api/data", victim, &api_key_headers("3")),
            RateLimitResult::Allowed { .. }
        ));
    }

    #[test]
    fn mixed_case_key_header_config_still_keys_by_header() {
        let rule = RateLimitRule {
            path_pattern: pattern("/api/*"),
            per_ip: 1,
            window_seconds: 3600,
            burst: 0,
            key_header: Some("X-Api-Key".to_string()),
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        };
        let rl = make_limiter(vec![rule]);

        // Distinct header values get distinct buckets; a case-sensitive lookup
        // would collapse both onto the per-IP bucket and reject the second.
        assert!(matches!(
            rl.check("/api/data", LOCAL, &api_key_headers("key-one")),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &api_key_headers("key-two")),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &api_key_headers("key-one")),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn bounded_prefix_respects_char_boundaries() {
        // 'é' is 2 bytes; cutting at an odd byte index must back up, not panic.
        let value = "é".repeat(40);
        let prefix = bounded_prefix(&value, 63);
        assert!(prefix.len() <= 63);
        assert!(value.starts_with(prefix));
    }

    // ── client identity ──────────────────────────────────────────────────────

    fn hourly_rule(path: &str, per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: pattern(path),
            per_ip,
            window_seconds: 3600,
            burst: 0,
            key_header: None,
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        }
    }

    #[test]
    fn ipv6_clients_share_one_bucket_per_64() {
        let rl = make_limiter(vec![hourly_rule("/api/login", 2)]);
        // Rotating the interface identifier inside one /64 buys nothing.
        for host in [
            "2001:db8:1:2::1",
            "2001:db8:1:2::ffff",
            "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
        ] {
            let _ = rl.check("/api/login", host.parse().unwrap(), &empty_headers());
        }
        assert!(matches!(
            rl.check(
                "/api/login",
                "2001:db8:1:2::9".parse().unwrap(),
                &empty_headers()
            ),
            RateLimitResult::Rejected { .. }
        ));
        // The neighbouring /64 is a different client.
        assert!(matches!(
            rl.check(
                "/api/login",
                "2001:db8:1:3::1".parse().unwrap(),
                &empty_headers()
            ),
            RateLimitResult::Allowed { .. }
        ));
    }

    #[test]
    fn ipv4_mapped_ipv6_clients_stay_per_ipv4_address() {
        // A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d; masking
        // those to a /64 would lump every IPv4 client into one bucket.
        let rl = make_limiter(vec![hourly_rule("/api/login", 1)]);
        let first: IpAddr = "::ffff:192.0.2.1".parse().unwrap();
        let second: IpAddr = "::ffff:192.0.2.2".parse().unwrap();
        assert!(matches!(
            rl.check("/api/login", first, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/login", second, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        // ...and a mapped address is the same client as its plain IPv4 form.
        assert!(matches!(
            rl.check("/api/login", "192.0.2.1".parse().unwrap(), &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn client_keys() {
        assert_eq!(client_key("10.1.2.3".parse().unwrap()), "10.1.2.3");
        assert_eq!(client_key("::ffff:10.1.2.3".parse().unwrap()), "10.1.2.3");
        assert_eq!(
            client_key("2001:db8:a:b:c:d:e:f".parse().unwrap()),
            "2001:db8:a:b::/64"
        );
        assert_eq!(client_key("::1".parse().unwrap()), "::/64");
    }

    // ── memory bound ─────────────────────────────────────────────────────────

    #[test]
    fn rotating_source_addresses_cannot_grow_the_store_past_its_cap() {
        let rl = RateLimiter::with_max_buckets(vec![hourly_rule("/api/login", 5)], 100);
        for i in 0..5_000u32 {
            let ip = IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + i));
            let _ = rl.check("/api/login", ip, &empty_headers());
        }
        assert!(rl.store.len() <= 100, "store holds {}", rl.store.len());
    }

    #[test]
    fn a_zero_bucket_cap_never_evicts() {
        let rl = RateLimiter::with_max_buckets(vec![hourly_rule("/api/login", 1)], 0);
        for i in 0..500u32 {
            let ip = IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + i));
            let _ = rl.check("/api/login", ip, &empty_headers());
        }
        assert_eq!(rl.store.len(), 500, "every client keeps its bucket");
        // So the first client is still out of budget.
        let first = IpAddr::V4(Ipv4Addr::from(0x0a00_0000));
        assert!(matches!(
            rl.check("/api/login", first, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    #[test]
    fn sweep_keeps_drained_buckets_so_long_windows_hold() {
        // Idle eviction used to reset a 1-per-hour bucket after 5 idle
        // minutes; the sweep only drops buckets that are full again.
        let rl = make_limiter(vec![hourly_rule("/api/login", 1)]);
        assert!(matches!(
            rl.check("/api/login", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        rl.sweep();
        assert!(matches!(
            rl.check("/api/login", LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
    }

    // ── canonical paths ──────────────────────────────────────────────────────

    #[test]
    fn wildcard_rule_covers_its_bare_prefix() {
        let rl = make_limiter(vec![api_rule(1)]);
        assert!(matches!(
            rl.check("/api", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { limit: 1, .. }
        ));
        // Same bucket as /api/users: the rule, not the path, keys it.
        assert!(matches!(
            rl.check("/api/users", LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
        assert!(matches!(
            rl.check("/apix", OTHER, &empty_headers()),
            RateLimitResult::Allowed { limit: 0, .. }
        ));
    }

    #[test]
    fn exact_rule_beats_wildcard_on_bare_prefix_in_either_order() {
        // "/auth/*" also covers "/auth", but a stricter exact "/auth" rule
        // must keep it - whichever of the two is listed first.
        let exact = || hourly_rule("/auth", 1);
        let wildcard = || hourly_rule("/auth/*", 100);
        for rules in [vec![exact(), wildcard()], vec![wildcard(), exact()]] {
            let rl = make_limiter(rules);
            assert!(matches!(
                rl.check("/auth", LOCAL, &empty_headers()),
                RateLimitResult::Allowed { limit: 1, .. }
            ));
            assert!(matches!(
                rl.check("/auth", LOCAL, &empty_headers()),
                RateLimitResult::Rejected { limit: 1, .. }
            ));
            // Below the prefix the wildcard is the only match.
            assert!(matches!(
                rl.check("/auth/login", LOCAL, &empty_headers()),
                RateLimitResult::Allowed { limit: 100, .. }
            ));
        }
    }

    #[test]
    fn bare_prefix_ties_break_toward_the_narrower_wildcard() {
        // On "/api", "/api/*" covers four literal bytes, like "/api*". Its
        // separator only breaks that tie (the narrower pattern wins); it
        // never makes the bare match count as longer than it is.
        let narrow = || hourly_rule("/api/*", 1);
        let broad = || hourly_rule("/api*", 100);
        for rules in [vec![narrow(), broad()], vec![broad(), narrow()]] {
            let rl = make_limiter(rules);
            assert!(matches!(
                rl.check("/api", LOCAL, &empty_headers()),
                RateLimitResult::Allowed { limit: 1, .. }
            ));
            assert!(matches!(
                rl.check("/apiary", LOCAL, &empty_headers()),
                RateLimitResult::Allowed { limit: 100, .. }
            ));
        }
        assert_eq!(
            specificity("/api/*", "/api").map(|s| s.matched),
            specificity("/api", "/api").map(|s| s.matched)
        );
        assert!(specificity("/api", "/api") > specificity("/api/*", "/api"));
        assert!(specificity("/api/*", "/api/x") > specificity("/api*", "/api/x"));
    }

    #[test]
    fn configured_patterns_are_canonicalized() {
        for (raw, canonical) in [
            ("/api/login/", "/api/login"),
            ("//api//login", "/api/login"),
            ("/api/*", "/api/*"),
            ("/api//*", "/api/*"),
            ("/api/*rest/", "/api/*rest"),
            ("/api*", "/api*"),
            ("/users/:id", "/users/:id"),
            ("/", "/"),
            ("/*", "/*"),
        ] {
            assert_eq!(pattern(raw).to_string(), canonical, "{raw}");
        }

        let rl = make_limiter(vec![hourly_rule("/api/login/", 1)]);
        assert!(matches!(
            rl.check("/api/login", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { limit: 1, .. }
        ));
    }

    #[test]
    fn exact_path_match_works() {
        let rule = RateLimitRule {
            path_pattern: pattern("/api/status"),
            per_ip: 1,
            window_seconds: 60,
            burst: 0,
            key_header: None,
            max_keys_per_client: DEFAULT_MAX_KEYS_PER_CLIENT,
        };
        let rl = make_limiter(vec![rule]);

        assert!(matches!(
            rl.check("/api/status", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/status", LOCAL, &empty_headers()),
            RateLimitResult::Rejected { .. }
        ));
        // Different path - no match
        assert!(matches!(
            rl.check("/api/status/detail", LOCAL, &empty_headers()),
            RateLimitResult::Allowed {
                remaining: u64::MAX,
                ..
            }
        ));
    }

    // ── rule syntax ──────────────────────────────────────────────────────────

    #[test]
    fn rule_syntax_catch_all_matches_like_the_bare_wildcard() {
        // `/api/*rest` is how every other path setting spells it; it used to
        // be compared literally and match nothing.
        for raw in ["/api/*rest", "/api/*"] {
            let rl = make_limiter(vec![hourly_rule(raw, 1)]);
            for (path, ip) in [("/api", LOCAL), ("/api/users/1", OTHER)] {
                assert!(matches!(
                    rl.check(path, ip, &empty_headers()),
                    RateLimitResult::Allowed { limit: 1, .. }
                ));
            }
            assert!(matches!(
                rl.check("/api/users", LOCAL, &empty_headers()),
                RateLimitResult::Rejected { .. }
            ));
            assert!(matches!(
                rl.check("/apiary", LOCAL, &empty_headers()),
                RateLimitResult::Allowed { limit: 0, .. }
            ));
        }
    }

    #[test]
    fn params_match_one_segment_and_literals_beat_them() {
        let rl = make_limiter(vec![
            hourly_rule("/users/:id/posts", 1),
            hourly_rule("/users/me/posts", 50),
            hourly_rule("/users/*rest", 100),
        ]);
        assert!(matches!(
            rl.check("/users/7/posts", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { limit: 1, .. }
        ));
        assert!(matches!(
            rl.check("/users/me/posts", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { limit: 50, .. }
        ));
        // A param covers one segment only: deeper paths fall to the catch-all.
        assert!(matches!(
            rl.check("/users/7/posts/2", LOCAL, &empty_headers()),
            RateLimitResult::Allowed { limit: 100, .. }
        ));
        assert!(specificity("/users/:id/posts", "/users/7/posts") > specificity("/users/*", "/users/7/posts"));
    }

    #[test]
    fn unparseable_patterns_are_refused() {
        for (raw, error) in [
            ("api/*", PatternError::NotAbsolute),
            ("*", PatternError::NotAbsolute),
            ("", PatternError::NotAbsolute),
            ("/api/*rest/x", PatternError::CatchAllNotLast),
            ("/a*b", PatternError::MisplacedWildcard),
            ("/api/**", PatternError::MisplacedWildcard),
            ("/a*/b", PatternError::MisplacedWildcard),
        ] {
            assert_eq!(PathPattern::parse(raw), Err(error), "{raw}");
        }
    }
}
