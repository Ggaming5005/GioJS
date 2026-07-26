//! giojs-ratelimit/src/lib.rs
//!
//! Token-bucket rate limiter. Multiple rules are evaluated in specificity order
//! (longest matching path prefix wins). Per-IP by default; per (IP, header
//! value) when `key_header` is configured - the IP is always part of the key
//! so a client rotating header values cannot mint unlimited fresh buckets,
//! and each IP is capped at a fixed number of distinct header-value buckets.
//!
//! Lock-free hot path: no Mutex per request.

mod bucket;
mod store;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use store::RateLimitStore;

pub use bucket::TokenBucket;

// Bounds bucket-key memory: only this many header-value bytes enter the key.
const MAX_KEY_HEADER_VALUE_BYTES: usize = 64;
// Distinct header-value buckets one IP may create per rule before falling
// back to the shared per-IP bucket (defeats header-rotation bucket minting).
const MAX_DISTINCT_HEADER_KEYS_PER_IP: u64 = 64;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RateLimitRule {
    /// Glob-style path pattern, e.g. "/api/*" or "/api/auth/*".
    pub path_pattern: String,
    /// Maximum requests allowed per `window_seconds` per client.
    pub per_ip: u64,
    /// Duration of the sliding window in seconds.
    pub window_seconds: u64,
    /// Extra requests permitted as a burst above the steady-state rate.
    pub burst: u64,
    /// If set, rate-limit by (client IP, value of this header) pairs - e.g.
    /// "x-api-key" - instead of the client IP alone. The value is truncated to
    /// MAX_KEY_HEADER_VALUE_BYTES; once an IP has created
    /// MAX_DISTINCT_HEADER_KEYS_PER_IP distinct buckets for this rule, further
    /// values share the per-IP bucket. Absent header falls back to the IP.
    pub key_header: Option<String>,
}

pub enum RateLimitResult {
    Allowed {
        remaining: u64,
        /// per_ip from the matched rule; 0 means no rule matched (skip headers).
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
        Self {
            store: Arc::new(RateLimitStore::new()),
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
        let Some((rule_index, rule)) = self.find_rule(path) else {
            return RateLimitResult::Allowed {
                remaining: u64::MAX,
                limit: 0,
            };
        };

        let key = self.build_key(rule_index, ip, rule, headers);
        let bucket = self
            .store
            .get_or_create(&key, rule.per_ip, rule.window_seconds, rule.burst);

        if bucket.try_consume() {
            RateLimitResult::Allowed {
                remaining: bucket.remaining_approx(),
                limit: rule.per_ip,
            }
        } else {
            let retry_after_secs = rule
                .window_seconds
                .checked_div(rule.per_ip)
                .unwrap_or(1)
                .max(1);
            RateLimitResult::Rejected {
                retry_after_secs,
                limit: rule.per_ip,
                rule_pattern: rule.path_pattern.clone(),
            }
        }
    }

    /// Evict idle bucket entries. Call from a periodic background task.
    pub fn evict_idle(&self, idle_secs: u64) {
        self.store.evict_idle(idle_secs);
    }

    /// Find the most-specific matching rule for `path`.
    /// Specificity = length of the literal prefix before the first `*`.
    fn find_rule(&self, path: &str) -> Option<(usize, &RateLimitRule)> {
        let mut best: Option<(usize, &RateLimitRule)> = None;
        let mut best_specificity: usize = 0;

        for (index, rule) in self.rules.iter().enumerate() {
            let specificity = match_path_pattern(&rule.path_pattern, path);
            if let Some(sp) = specificity {
                if sp >= best_specificity {
                    best_specificity = sp;
                    best = Some((index, rule));
                }
            }
        }

        best
    }

    /// Build the bucket key for the matched rule. Header-keyed rules always
    /// compound with the client IP so rotating the header cannot escape the
    /// IP's budget; once the IP saturates its distinct-key allowance the
    /// shared per-IP bucket is used instead.
    fn build_key(
        &self,
        rule_index: usize,
        ip: IpAddr,
        rule: &RateLimitRule,
        headers: &HashMap<String, String>,
    ) -> String {
        let ip_key = format!("{rule_index}:{ip}");
        let Some(header_name) = rule.key_header.as_deref() else {
            return ip_key;
        };
        let Some(value) = headers.get(header_name) else {
            return ip_key;
        };
        let compound_key = format!(
            "{rule_index}:{ip}:{}",
            bounded_prefix(value, MAX_KEY_HEADER_VALUE_BYTES)
        );
        if self.store.contains(&compound_key)
            || self
                .store
                .try_admit_distinct(&ip_key, MAX_DISTINCT_HEADER_KEYS_PER_IP)
        {
            compound_key
        } else {
            ip_key
        }
    }
}

// ── Path pattern matching ─────────────────────────────────────────────────────

/// Match `pattern` against `path`. Returns the specificity (length of the
/// literal prefix before `*`) on success, or `None` if no match.
///
/// Rules:
///   - Exact match: "/api/auth" matches only "/api/auth"
///   - Wildcard: "/api/*" matches "/api/" and any suffix
///   - No wildcard means exact match required
fn match_path_pattern(pattern: &str, path: &str) -> Option<usize> {
    if let Some(prefix) = pattern.strip_suffix('*') {
        if path.starts_with(prefix) {
            return Some(prefix.len());
        }
        None
    } else {
        // Exact match
        if pattern == path {
            Some(pattern.len())
        } else {
            None
        }
    }
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

    fn make_limiter(rules: Vec<RateLimitRule>) -> RateLimiter {
        RateLimiter::new(rules)
    }

    fn api_rule(per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: "/api/*".to_string(),
            per_ip,
            window_seconds: 60,
            burst: 0,
            key_header: None,
        }
    }

    fn api_auth_rule(per_ip: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: "/api/auth/*".to_string(),
            per_ip,
            window_seconds: 60,
            burst: 0,
            key_header: None,
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

    fn keyed_rule(per_ip: u64, window_seconds: u64) -> RateLimitRule {
        RateLimitRule {
            path_pattern: "/api/*".to_string(),
            per_ip,
            window_seconds,
            burst: 0,
            key_header: Some("x-api-key".to_string()),
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
        let expected = (MAX_DISTINCT_HEADER_KEYS_PER_IP as usize) + 1;
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
    fn bounded_prefix_respects_char_boundaries() {
        // 'é' is 2 bytes; cutting at an odd byte index must back up, not panic.
        let value = "é".repeat(40);
        let prefix = bounded_prefix(&value, 63);
        assert!(prefix.len() <= 63);
        assert!(value.starts_with(prefix));
    }

    #[test]
    fn exact_path_match_works() {
        let rule = RateLimitRule {
            path_pattern: "/api/status".to_string(),
            per_ip: 1,
            window_seconds: 60,
            burst: 0,
            key_header: None,
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
}
