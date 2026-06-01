//! giojs-prefetch/src/lib.rs
//!
//! Per-client prefetch budget enforcement. Tracks in-flight and per-second
//! request counts keyed by client IP. Caps concurrent prefetches to prevent
//! bandwidth abuse from aggressive link-viewport-prefetch polyfills.
//!
//! Limits (configurable via PrefetchConfig):
//!   - max 5 concurrent in-flight prefetches per client IP
//!   - max 20 prefetch requests per second per client IP
//!
//! Call `evict_idle(60)` from a periodic background task to bound memory growth.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PrefetchConfig {
    pub max_in_flight: usize,
    pub max_per_second: usize,
}

impl Default for PrefetchConfig {
    fn default() -> Self {
        PrefetchConfig {
            max_in_flight: 5,
            max_per_second: 20,
        }
    }
}

pub struct PrefetchBudgets {
    budgets: DashMap<IpAddr, ClientBudget>,
    max_in_flight: usize,
    max_per_second: usize,
}

struct ClientBudget {
    in_flight: AtomicUsize,
    window_count: AtomicUsize,
    window_start_secs: AtomicU64,
    last_seen_secs: AtomicU64,
}

// ── PrefetchBudgets impl ──────────────────────────────────────────────────────

impl PrefetchBudgets {
    pub fn new(config: PrefetchConfig) -> Self {
        PrefetchBudgets {
            budgets: DashMap::new(),
            max_in_flight: config.max_in_flight,
            max_per_second: config.max_per_second,
        }
    }

    /// Returns `true` and increments both counters if within budget.
    /// Returns `false` (caller should respond 429) if any limit is exceeded.
    ///
    /// CAS loops on both counters ensure strictly bounded concurrency even when
    /// many requests arrive simultaneously and observe the same initial values.
    pub fn try_acquire(&self, ip: IpAddr) -> bool {
        let now = unix_now_secs();
        let entry = self.budgets.entry(ip).or_insert_with(|| ClientBudget {
            in_flight: AtomicUsize::new(0),
            window_count: AtomicUsize::new(0),
            window_start_secs: AtomicU64::new(now),
            last_seen_secs: AtomicU64::new(now),
        });

        entry.last_seen_secs.store(now, Ordering::Relaxed);

        // CAS on window_start so only one thread resets the per-second counter.
        let window_start = entry.window_start_secs.load(Ordering::Acquire);
        if now > window_start
            && entry
                .window_start_secs
                .compare_exchange(window_start, now, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
        {
            entry.window_count.store(0, Ordering::Release);
        }

        // CAS loop: atomically increment in_flight only if still under the cap.
        loop {
            let current = entry.in_flight.load(Ordering::Acquire);
            if current >= self.max_in_flight {
                return false;
            }
            if entry
                .in_flight
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                break;
            }
        }

        // CAS loop: atomically increment window_count only if still under rate limit.
        loop {
            let current = entry.window_count.load(Ordering::Acquire);
            if current >= self.max_per_second {
                entry.in_flight.fetch_sub(1, Ordering::Release);
                return false;
            }
            if entry
                .window_count
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                break;
            }
        }

        true
    }

    /// Decrements the in-flight counter after the response is sent.
    pub fn release(&self, ip: IpAddr) {
        if let Some(entry) = self.budgets.get(&ip) {
            if entry.in_flight.load(Ordering::Relaxed) > 0 {
                entry.in_flight.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }

    /// Removes entries that have been idle for more than `idle_secs` seconds.
    /// Intended to be called from a periodic background task (e.g., every 60s).
    pub fn evict_idle(&self, idle_secs: u64) {
        let cutoff = unix_now_secs().saturating_sub(idle_secs);
        self.budgets
            .retain(|_, entry| entry.last_seen_secs.load(Ordering::Relaxed) >= cutoff);
    }
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
    const OTHER: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1));

    fn budget(max_in_flight: usize, max_per_second: usize) -> PrefetchBudgets {
        PrefetchBudgets::new(PrefetchConfig {
            max_in_flight,
            max_per_second,
        })
    }

    #[test]
    fn budget_allows_requests_under_limit() {
        let b = budget(5, 20);
        for _ in 0..5 {
            assert!(b.try_acquire(LOCAL));
        }
    }

    #[test]
    fn budget_blocks_sixth_concurrent_request() {
        let b = budget(5, 20);
        for _ in 0..5 {
            assert!(b.try_acquire(LOCAL));
        }
        assert!(!b.try_acquire(LOCAL));
    }

    #[test]
    fn budget_resets_after_in_flight_completes() {
        let b = budget(1, 20);
        assert!(b.try_acquire(LOCAL));
        assert!(!b.try_acquire(LOCAL));
        b.release(LOCAL);
        assert!(b.try_acquire(LOCAL));
    }

    #[test]
    fn non_prefetch_ips_have_independent_budgets() {
        let b = budget(1, 20);
        assert!(b.try_acquire(LOCAL));
        assert!(!b.try_acquire(LOCAL));
        assert!(b.try_acquire(OTHER));
    }

    #[test]
    fn rate_limit_blocks_after_max_per_second() {
        let b = budget(100, 5);
        for _ in 0..5 {
            assert!(b.try_acquire(LOCAL));
        }
        assert!(!b.try_acquire(LOCAL));
    }

    #[test]
    fn idle_entries_are_evicted() {
        let b = budget(5, 20);
        b.try_acquire(LOCAL);
        b.release(LOCAL);
        b.budgets
            .get(&LOCAL)
            .unwrap()
            .last_seen_secs
            .store(0, Ordering::Relaxed);
        b.evict_idle(60);
        assert!(!b.budgets.contains_key(&LOCAL));
    }
}
