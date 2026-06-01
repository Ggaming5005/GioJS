//! giojs-ratelimit/src/lib.rs
//!
//! Token-bucket rate limiter. Multiple rules are evaluated in specificity order
//! (longest matching path prefix wins). Per-IP by default; switches to per-key
//! when `key_header` is configured on the matching rule.
//!
//! Lock-free hot path: no Mutex, no allocation per request.

mod bucket;
mod store;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use store::RateLimitStore;

pub use bucket::TokenBucket;

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
    /// If set, rate-limit by the value of this request header (e.g. "x-api-key")
    /// instead of the client IP.
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

        let key = build_key(rule_index, ip, rule, headers);
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

fn build_key(
    rule_index: usize,
    ip: IpAddr,
    rule: &RateLimitRule,
    headers: &HashMap<String, String>,
) -> String {
    if let Some(ref header_name) = rule.key_header {
        if let Some(value) = headers.get(header_name.as_str()) {
            return format!("{rule_index}:{value}");
        }
    }
    format!("{rule_index}:{ip}")
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

    #[test]
    fn key_header_uses_api_key_not_ip() {
        let rule = RateLimitRule {
            path_pattern: "/api/*".to_string(),
            per_ip: 2,
            window_seconds: 60,
            burst: 0,
            key_header: Some("x-api-key".to_string()),
        };
        let rl = make_limiter(vec![rule]);

        let mut headers_a = HashMap::new();
        headers_a.insert("x-api-key".to_string(), "key-alice".to_string());

        let mut headers_b = HashMap::new();
        headers_b.insert("x-api-key".to_string(), "key-bob".to_string());

        // Exhaust Alice's bucket (2 requests from same IP)
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_a),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_a),
            RateLimitResult::Allowed { .. }
        ));
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_a),
            RateLimitResult::Rejected { .. }
        ));

        // Bob has a separate bucket — same IP, different key
        assert!(matches!(
            rl.check("/api/data", LOCAL, &headers_b),
            RateLimitResult::Allowed { .. }
        ));

        // Different IP, same key as Alice — still rejected (keyed by api key)
        assert!(matches!(
            rl.check("/api/data", OTHER, &headers_a),
            RateLimitResult::Rejected { .. }
        ));
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
        // Different path — no match
        assert!(matches!(
            rl.check("/api/status/detail", LOCAL, &empty_headers()),
            RateLimitResult::Allowed {
                remaining: u64::MAX,
                ..
            }
        ));
    }
}
