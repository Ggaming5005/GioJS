//! store.rs
//!
//! Per-key bucket storage. DashMap provides lock-free concurrent access.
//! Keys are "{rule_index}|{client}" or "{rule_index}|{client}|{header_value}".
//! A per-group distinct-key counter caps how many header-value buckets one
//! client can hold at once.
//!
//! Memory is bounded two ways. `sweep` (periodic, and on demand at the cap)
//! drops buckets that have refilled to capacity: a recreated bucket starts
//! full, so this never hands a client extra budget - unlike evicting merely
//! idle buckets, which reset long windows early. If the store is still at
//! `max_entries` after a sweep (an attacker rotating source addresses keeps
//! every bucket partly drained), the least recently seen tenth is evicted.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;

use crate::bucket::{unix_now_ms, TokenBucket};

struct BucketEntry {
    bucket: Arc<TokenBucket>,
    last_seen_ms: AtomicU64,
    /// Distinct-key group a compound (header-keyed) bucket was admitted
    /// under; its slot is released when the bucket leaves the store.
    group: Option<String>,
}

pub struct RateLimitStore {
    entries: DashMap<String, Arc<BucketEntry>>,
    /// Live compound buckets per group. Lock order is always `entries`
    /// before `distinct_counts`, never the reverse.
    distinct_counts: DashMap<String, AtomicU64>,
    max_entries: usize,
    /// Set while one thread makes room, so a burst of inserts at the cap
    /// triggers one sweep instead of one per insert.
    making_room: AtomicBool,
}

impl RateLimitStore {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: DashMap::new(),
            distinct_counts: DashMap::new(),
            max_entries: max_entries.max(1),
            making_room: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
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
        if let Some(bucket) = self.touch(key) {
            return bucket;
        }
        self.make_room();
        let entry = self
            .entries
            .entry(key.to_string())
            .or_insert_with(|| new_entry(per_ip, window_seconds, burst, None));
        entry.last_seen_ms.store(unix_now_ms(), Ordering::Relaxed);
        entry.bucket.clone()
    }

    /// Like `get_or_create` for a header-keyed bucket that counts against
    /// `group`'s allowance of `cap` live buckets. Returns `None` when the key
    /// is new and the group is saturated, so the caller falls back to a
    /// shared bucket instead of minting unbounded fresh ones. Admission and
    /// insertion happen under the same shard lock, so the count stays exact.
    pub fn get_or_create_in_group(
        &self,
        key: &str,
        group: &str,
        cap: u64,
        per_ip: u64,
        window_seconds: u64,
        burst: u64,
    ) -> Option<Arc<TokenBucket>> {
        if let Some(bucket) = self.touch(key) {
            return Some(bucket);
        }
        self.make_room();
        match self.entries.entry(key.to_string()) {
            Entry::Occupied(occupied) => {
                let entry = occupied.get();
                entry.last_seen_ms.store(unix_now_ms(), Ordering::Relaxed);
                Some(entry.bucket.clone())
            }
            Entry::Vacant(vacant) => {
                let admitted = self
                    .distinct_counts
                    .entry(group.to_string())
                    .or_insert_with(|| AtomicU64::new(0))
                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                        (count < cap).then_some(count + 1)
                    })
                    .is_ok();
                if !admitted {
                    return None;
                }
                let entry = new_entry(per_ip, window_seconds, burst, Some(group.to_string()));
                let bucket = entry.bucket.clone();
                vacant.insert(entry);
                Some(bucket)
            }
        }
    }

    /// Drop every bucket that has refilled to capacity. Lossless: the next
    /// request recreates it full. Call periodically from a background task.
    pub fn sweep(&self) {
        let now = unix_now_ms();
        self.entries.retain(|_, entry| {
            let keep = !entry.bucket.is_full_at(now);
            if !keep {
                self.release_group_slot(entry);
            }
            keep
        });
        self.prune_empty_groups();
    }

    fn touch(&self, key: &str) -> Option<Arc<TokenBucket>> {
        let entry = self.entries.get(key)?;
        entry.last_seen_ms.store(unix_now_ms(), Ordering::Relaxed);
        Some(entry.bucket.clone())
    }

    /// Called before inserting a new key. Overshoot is bounded by the number
    /// of inserts racing the thread that is making room.
    fn make_room(&self) {
        if self.entries.len() < self.max_entries {
            return;
        }
        if self.making_room.swap(true, Ordering::AcqRel) {
            return;
        }
        self.sweep();
        let len = self.entries.len();
        if len >= self.max_entries {
            // Evict a batch, not one entry: finding the oldest is O(n), and
            // a tenth of the cap amortizes that over the next many inserts.
            let excess = len + 1 - self.max_entries;
            self.evict_least_recent(excess + self.max_entries / 10);
        }
        self.making_room.store(false, Ordering::Release);
    }

    fn evict_least_recent(&self, count: usize) {
        let mut seen: Vec<u64> = self
            .entries
            .iter()
            .map(|entry| entry.last_seen_ms.load(Ordering::Relaxed))
            .collect();
        if seen.is_empty() {
            return;
        }
        let nth = count.min(seen.len()) - 1;
        let (_, cutoff, _) = seen.select_nth_unstable(nth);
        let cutoff = *cutoff;
        self.entries.retain(|_, entry| {
            let keep = entry.last_seen_ms.load(Ordering::Relaxed) > cutoff;
            if !keep {
                self.release_group_slot(entry);
            }
            keep
        });
        self.prune_empty_groups();
    }

    fn release_group_slot(&self, entry: &BucketEntry) {
        if let Some(group) = entry.group.as_deref() {
            if let Some(count) = self.distinct_counts.get(group) {
                let _ =
                    count.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| c.checked_sub(1));
            }
        }
    }

    fn prune_empty_groups(&self) {
        self.distinct_counts
            .retain(|_, count| count.load(Ordering::Relaxed) > 0);
    }

    #[cfg(test)]
    fn group_count(&self, group: &str) -> u64 {
        self.distinct_counts
            .get(group)
            .map_or(0, |count| count.load(Ordering::Relaxed))
    }
}

fn new_entry(
    per_ip: u64,
    window_seconds: u64,
    burst: u64,
    group: Option<String>,
) -> Arc<BucketEntry> {
    Arc::new(BucketEntry {
        bucket: Arc::new(TokenBucket::new(per_ip, window_seconds, burst)),
        last_seen_ms: AtomicU64::new(unix_now_ms()),
        group,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_drops_only_buckets_that_refilled() {
        let store = RateLimitStore::new(100);
        store.get_or_create("full", 5, 3600, 0);
        assert!(store.get_or_create("drained", 5, 3600, 0).try_consume());
        store.sweep();
        assert_eq!(store.len(), 1);
        // The drained bucket kept its state: 4 tokens left, not a fresh 5.
        let drained = store.get_or_create("drained", 5, 3600, 0);
        assert_eq!(drained.remaining_approx(), 4);
    }

    #[test]
    fn store_never_grows_past_its_cap() {
        let store = RateLimitStore::new(50);
        for i in 0..1_000 {
            // Drain each bucket so the lossless sweep cannot free anything
            // and the cap has to evict.
            store
                .get_or_create(&format!("0|10.0.{}.{}", i / 256, i % 256), 1, 3600, 0)
                .try_consume();
            assert!(
                store.len() <= 50,
                "len {} after {} inserts",
                store.len(),
                i + 1
            );
        }
    }

    #[test]
    fn eviction_at_the_cap_removes_the_least_recently_seen() {
        let store = RateLimitStore::new(10);
        for i in 0..10 {
            store
                .get_or_create(&format!("k{i}"), 1, 3600, 0)
                .try_consume();
            // Distinct last-seen stamps so the oldest is unambiguous.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        store.get_or_create("k0", 1, 3600, 0); // refresh k0: now the newest
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.get_or_create("new", 1, 3600, 0);
        assert!(store.len() <= 10);
        assert!(
            store.entries.contains_key("k0"),
            "recently seen key survives"
        );
        assert!(!store.entries.contains_key("k1"), "oldest key is evicted");
        assert!(store.entries.contains_key("new"));
    }

    #[test]
    fn group_admission_is_capped_and_released_when_buckets_leave() {
        let store = RateLimitStore::new(100);
        for i in 0..3 {
            let bucket = store.get_or_create_in_group(&format!("g|{i}"), "g", 3, 1, 1, 0);
            bucket.expect("admitted under the cap").try_consume();
        }
        assert!(store
            .get_or_create_in_group("g|3", "g", 3, 1, 1, 0)
            .is_none());
        // Existing members are still served at the cap.
        assert!(store
            .get_or_create_in_group("g|0", "g", 3, 1, 1, 0)
            .is_some());
        assert_eq!(store.group_count("g"), 3);

        // 1 per second: after a second every bucket is full again, the sweep
        // drops them and their slots return to the group.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        store.sweep();
        assert_eq!(store.len(), 0);
        assert_eq!(store.group_count("g"), 0);
        assert!(store.distinct_counts.is_empty());
        assert!(store
            .get_or_create_in_group("g|9", "g", 3, 1, 1, 0)
            .is_some());
    }

    #[test]
    fn eviction_releases_group_slots() {
        let store = RateLimitStore::new(4);
        for i in 0..4 {
            store
                .get_or_create_in_group(&format!("g|{i}"), "g", 64, 1, 3600, 0)
                .expect("admitted")
                .try_consume();
        }
        store.get_or_create("other", 1, 3600, 0);
        assert!(store.len() <= 4);
        let live = store
            .entries
            .iter()
            .filter(|entry| entry.group.as_deref() == Some("g"))
            .count() as u64;
        assert_eq!(store.group_count("g"), live);
    }
}
