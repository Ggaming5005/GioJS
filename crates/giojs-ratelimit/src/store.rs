//! store.rs
//!
//! Per-key bucket storage. DashMap provides lock-free concurrent access.
//! Keys are "{rule_index}:{client_ip}" or "{rule_index}:{client_ip}:{header_value}".
//! A per-group distinct-key counter caps how many header-value buckets one IP
//! can create. Call `evict_idle` from a background task to bound memory growth.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;

use crate::bucket::TokenBucket;

struct BucketEntry {
    bucket: Arc<TokenBucket>,
    last_seen_ms: AtomicU64,
}

struct DistinctCountEntry {
    count: AtomicU64,
    last_seen_ms: AtomicU64,
}

pub struct RateLimitStore {
    entries: DashMap<String, Arc<BucketEntry>>,
    distinct_counts: DashMap<String, DistinctCountEntry>,
}

impl RateLimitStore {
    pub fn new() -> Self {
        Self {
            entries: DashMap::new(),
            distinct_counts: DashMap::new(),
        }
    }

    /// True if a bucket already exists for `key`.
    pub fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// Admit one more distinct compound key under `group_key`, up to `cap`.
    /// Returns false once the group is saturated so callers fall back to a
    /// shared bucket instead of creating unbounded fresh ones.
    pub fn try_admit_distinct(&self, group_key: &str, cap: u64) -> bool {
        let entry = self
            .distinct_counts
            .entry(group_key.to_string())
            .or_insert_with(|| DistinctCountEntry {
                count: AtomicU64::new(0),
                last_seen_ms: AtomicU64::new(unix_now_ms()),
            });
        entry.last_seen_ms.store(unix_now_ms(), Ordering::Relaxed);
        entry
            .count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                (count < cap).then_some(count + 1)
            })
            .is_ok()
    }

    /// Return the existing bucket for `key`, or create a new one using the
    /// provided `per_ip`, `window_seconds`, and `burst` parameters.
    pub fn get_or_create(
        &self,
        key: &str,
        per_ip: u64,
        window_seconds: u64,
        burst: u64,
    ) -> Arc<TokenBucket> {
        let entry = self.entries.entry(key.to_string()).or_insert_with(|| {
            Arc::new(BucketEntry {
                bucket: Arc::new(TokenBucket::new(per_ip, window_seconds, burst)),
                last_seen_ms: AtomicU64::new(unix_now_ms()),
            })
        });

        entry.last_seen_ms.store(unix_now_ms(), Ordering::Relaxed);
        entry.bucket.clone()
    }

    /// Remove entries that have been idle for more than `idle_secs` seconds.
    /// Intended to be called periodically from a background task.
    pub fn evict_idle(&self, idle_secs: u64) {
        let cutoff_ms = unix_now_ms().saturating_sub(idle_secs * 1_000);
        self.entries
            .retain(|_, entry| entry.last_seen_ms.load(Ordering::Relaxed) >= cutoff_ms);
        self.distinct_counts
            .retain(|_, entry| entry.last_seen_ms.load(Ordering::Relaxed) >= cutoff_ms);
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
