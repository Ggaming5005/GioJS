//! bucket.rs
//!
//! Lock-free token bucket. Tokens are stored scaled by TOKEN_SCALE to allow
//! fractional-rate refill without floating-point arithmetic. AtomicU64 +
//! compare_exchange ensure no locks are held on the request hot-path.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// 1 token = TOKEN_SCALE internal units. At 1_000_000, rates as low as
// 1 request per 1000 seconds maintain sub-percent precision.
const TOKEN_SCALE: u64 = 1_000_000;

pub struct TokenBucket {
    // Current token count in internal units (tokens * TOKEN_SCALE)
    tokens_scaled: AtomicU64,
    // Unix timestamp of last successful token consumption, in milliseconds
    last_refill_ms: AtomicU64,
    // Maximum stored tokens (burst ceiling)
    capacity_scaled: u64,
    // Refill rate: TOKEN_SCALE units added per millisecond
    // = per_ip * 1_000 / window_seconds (pre-divided by 1000 for ms conversion)
    rate_per_ms: u64,
}

impl TokenBucket {
    /// Create a new full bucket. `per_ip` requests allowed per `window_seconds`.
    /// `burst` extra requests are permitted as a spike above the steady-state rate.
    pub fn new(per_ip: u64, window_seconds: u64, burst: u64) -> Self {
        // rate: per_ip tokens per window_seconds seconds = per_ip/window_seconds/1000 per ms
        // Scaled: per_ip * TOKEN_SCALE / window_seconds / 1000 = per_ip * 1000 / window_seconds
        let rate_per_ms = (per_ip * 1_000).saturating_div(window_seconds.max(1));
        let capacity_scaled = (per_ip + burst).saturating_mul(TOKEN_SCALE);
        Self {
            tokens_scaled: AtomicU64::new(capacity_scaled),
            last_refill_ms: AtomicU64::new(unix_now_ms()),
            capacity_scaled,
            rate_per_ms,
        }
    }

    /// Attempt to consume one token. Returns `true` if the request is allowed.
    ///
    /// Uses a CAS loop so multiple concurrent callers never double-consume.
    /// Refill is computed lazily from elapsed time since last consumption.
    /// Slight over-generosity is possible under extreme concurrency (see
    /// X-RateLimit-Remaining approximation note in SPEC2 §27).
    pub fn try_consume(&self) -> bool {
        let now = unix_now_ms();

        loop {
            let last = self.last_refill_ms.load(Ordering::Acquire);
            let current = self.tokens_scaled.load(Ordering::Acquire);

            let elapsed = now.saturating_sub(last);
            let added = self.rate_per_ms.saturating_mul(elapsed);
            let available = current.saturating_add(added).min(self.capacity_scaled);

            if available < TOKEN_SCALE {
                return false;
            }

            let new_tokens = available - TOKEN_SCALE;
            if self
                .tokens_scaled
                .compare_exchange(current, new_tokens, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                // Advance last_refill only if it hasn't been updated by a racing thread.
                let _ = self.last_refill_ms.compare_exchange(
                    last,
                    now,
                    Ordering::Release,
                    Ordering::Relaxed,
                );
                return true;
            }
            // CAS lost — another thread updated tokens concurrently; retry.
        }
    }

    /// Approximate number of remaining allowed requests in the current window.
    /// May be slightly inaccurate under concurrent load (documented behavior).
    pub fn remaining_approx(&self) -> u64 {
        self.tokens_scaled.load(Ordering::Relaxed) / TOKEN_SCALE
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn allow_requests_within_limit() {
        // 5 per 10 seconds, burst 0 → bucket starts with 5 tokens
        let bucket = TokenBucket::new(5, 10, 0);
        for _ in 0..5 {
            assert!(
                bucket.try_consume(),
                "requests within limit should be allowed"
            );
        }
    }

    #[test]
    fn reject_when_bucket_empty() {
        let bucket = TokenBucket::new(3, 60, 0);
        for _ in 0..3 {
            bucket.try_consume();
        }
        assert!(!bucket.try_consume(), "4th request should be rejected");
    }

    #[test]
    fn refill_over_time() {
        // 10 per second, burst 0 — drain it, sleep 200ms, should have ~2 tokens
        let bucket = TokenBucket::new(10, 1, 0);
        for _ in 0..10 {
            bucket.try_consume();
        }
        assert!(!bucket.try_consume(), "bucket must be empty after draining");

        std::thread::sleep(std::time::Duration::from_millis(200));
        // After 200ms at 10/sec rate, ~2 tokens should have refilled
        assert!(
            bucket.try_consume(),
            "bucket should have refilled after wait"
        );
    }

    #[test]
    fn burst_allows_short_spike_above_base_rate() {
        // 1 per second, burst 4 → starts with 5 tokens total (1+4)
        let bucket = TokenBucket::new(1, 1, 4);
        // All 5 should succeed immediately
        for i in 0..5 {
            assert!(bucket.try_consume(), "burst request {i} should be allowed");
        }
        // 6th should fail — burst exhausted
        assert!(!bucket.try_consume(), "6th request exceeds burst limit");
    }

    #[test]
    fn concurrent_try_consume_is_safe() {
        // 100 per 600s, burst 0 — 200 threads each try once.
        // The long window keeps refill below 1 token even if threads take a few ms.
        // Per SPEC2 §27: remaining count is approximate; allow ±1 inaccuracy.
        let bucket = Arc::new(TokenBucket::new(100, 600, 0));
        let mut handles = Vec::new();

        for _ in 0..200 {
            let b = bucket.clone();
            handles.push(thread::spawn(move || b.try_consume()));
        }

        let allowed: usize = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|&ok| ok)
            .count();
        assert!(
            (99..=101).contains(&allowed),
            "approximately 100 requests should be allowed (lock-free ±1); got {allowed}",
        );
    }
}
