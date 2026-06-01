//! giojs-cache/src/lib.rs
//!
//! ISR-equivalent page cache with memory LRU + disk persistence and
//! stale-while-revalidate semantics. Redis support is deferred to Phase 3.
//!
//! Lookup order: memory LRU → disk → miss.
//! All writes go to memory immediately and to disk in a background task.

mod backend;
mod disk;
mod key;
mod memory;
mod singleflight;

pub use backend::{CacheBackend, LocalBackend};
pub use key::build_cache_key;
pub use singleflight::SingleFlight;

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::SystemTime;

use bytes::Bytes;
use thiserror::Error;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub html: Bytes,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub created_at: SystemTime,
    pub max_age_secs: u64,
    pub deployment_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheStatus {
    Hit,
    /// Past `max_age` but within `max_age * swr_multiplier` — serve stale,
    /// trigger background revalidation.
    Stale,
}

#[derive(Debug, Clone)]
pub struct CacheConfig {
    /// Maximum number of entries kept in memory (LRU eviction).
    pub memory_max_entries: NonZeroUsize,
    /// Directory for on-disk JSON files.
    pub disk_dir: PathBuf,
    /// Stale-while-revalidate window = `max_age_secs * swr_multiplier`.
    /// A value of 0 disables SWR (stale entries are always misses).
    pub swr_multiplier: u64,
    /// Upper bound on total bytes kept on disk. Oldest files are evicted past
    /// this limit by `evict_disk`. A value of 0 disables the bound.
    pub disk_max_bytes: u64,
}

impl Default for CacheConfig {
    fn default() -> Self {
        CacheConfig {
            memory_max_entries: NonZeroUsize::new(1000).expect("non-zero"),
            disk_dir: PathBuf::from(".gio/cache/pages"),
            swr_multiplier: 10,
            disk_max_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("disk write failed: {0}")]
    DiskWrite(#[from] std::io::Error),
    #[error("serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
}

// ── PageCache ─────────────────────────────────────────────────────────────────

pub struct PageCache {
    backend: LocalBackend,
    swr_multiplier: u64,
}

impl PageCache {
    pub fn new(config: CacheConfig) -> Self {
        PageCache {
            backend: LocalBackend::new(
                config.memory_max_entries,
                config.disk_dir,
                config.disk_max_bytes,
            ),
            swr_multiplier: config.swr_multiplier,
        }
    }

    /// Evict the oldest on-disk entries until total size is within
    /// `disk_max_bytes`. A no-op when the bound is disabled (0).
    pub async fn evict_disk(&self) {
        self.backend.evict_disk().await;
    }

    /// Build a SHA256 cache key. Delegates to `key::build_cache_key`.
    pub fn build_key(method: &str, path: &str, query: &str) -> String {
        build_cache_key(method, path, query)
    }

    /// Look up an entry. Returns `None` on miss, `Some((entry, status))` on hit or stale.
    ///
    /// A deployment ID mismatch is always treated as a miss so stale pages from
    /// a previous build are never served after a deploy.
    pub async fn get(&self, key: &str, deployment_id: &str) -> Option<(CacheEntry, CacheStatus)> {
        let entry = self.backend.get(key).await?;

        if entry.deployment_id != deployment_id {
            return None;
        }

        let status = self.classify(&entry);
        status.map(|s| (entry, s))
    }

    /// Return (entry_count, total_html_bytes) for the in-memory layer.
    pub fn stats(&self) -> (usize, usize) {
        self.backend.stats()
    }

    /// Store an entry. Writes to memory immediately; disk write is non-blocking.
    pub async fn put(&self, key: &str, entry: CacheEntry) -> Result<(), CacheError> {
        self.backend.put(key, entry).await
    }

    // ── private helpers ───────────────────────────────────────────────────────

    fn classify(&self, entry: &CacheEntry) -> Option<CacheStatus> {
        let age_secs = SystemTime::now()
            .duration_since(entry.created_at)
            .unwrap_or_default()
            .as_secs();

        if age_secs < entry.max_age_secs {
            return Some(CacheStatus::Hit);
        }

        if self.swr_multiplier > 0 {
            let swr_window = entry.max_age_secs.saturating_mul(self.swr_multiplier);
            if age_secs < swr_window {
                return Some(CacheStatus::Stale);
            }
        }

        None // expired beyond SWR window
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn make_entry(max_age_secs: u64, age_offset_secs: i64) -> CacheEntry {
        // created_at in the past by `age_offset_secs`
        let created_at = if age_offset_secs >= 0 {
            SystemTime::now()
                .checked_sub(Duration::from_secs(age_offset_secs as u64))
                .unwrap_or(UNIX_EPOCH)
        } else {
            SystemTime::now()
                .checked_add(Duration::from_secs((-age_offset_secs) as u64))
                .unwrap_or(SystemTime::now())
        };
        CacheEntry {
            html: Bytes::from("<h1>Test</h1>"),
            status: 200,
            headers: HashMap::new(),
            created_at,
            max_age_secs,
            deployment_id: "deploy-1".to_string(),
        }
    }

    fn cache_with_swr(multiplier: u64) -> PageCache {
        PageCache::new(CacheConfig {
            memory_max_entries: NonZeroUsize::new(100).unwrap(),
            disk_dir: std::env::temp_dir().join("giojs-cache-test"),
            swr_multiplier: multiplier,
            disk_max_bytes: 0,
        })
    }

    #[tokio::test]
    async fn miss_on_empty_cache() {
        let cache = cache_with_swr(10);
        assert!(cache.get("nonexistent", "deploy-1").await.is_none());
    }

    #[tokio::test]
    async fn hit_after_put() {
        let cache = cache_with_swr(10);
        let entry = make_entry(3600, 0); // fresh, expires in 1h
        cache.put("key1", entry).await.unwrap();
        let result = cache.get("key1", "deploy-1").await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().1, CacheStatus::Hit);
    }

    #[tokio::test]
    async fn stale_after_max_age_expires() {
        let cache = cache_with_swr(10);
        // Entry created 65 seconds ago, max_age=60 → stale (within 10x SWR window)
        let entry = make_entry(60, 65);
        cache.put("key2", entry).await.unwrap();
        let result = cache.get("key2", "deploy-1").await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().1, CacheStatus::Stale);
    }

    #[tokio::test]
    async fn miss_after_swr_window_expires() {
        let cache = cache_with_swr(2);
        // max_age=60, swr_multiplier=2 → SWR window = 120s
        // Entry is 130s old → fully expired
        let entry = make_entry(60, 130);
        cache.put("key3", entry).await.unwrap();
        assert!(cache.get("key3", "deploy-1").await.is_none());
    }

    #[tokio::test]
    async fn deployment_id_mismatch_is_a_miss() {
        let cache = cache_with_swr(10);
        let entry = make_entry(3600, 0);
        cache.put("key4", entry).await.unwrap();
        // Lookup with a different deployment ID
        assert!(cache.get("key4", "deploy-2").await.is_none());
    }

    #[tokio::test]
    async fn swr_disabled_when_multiplier_is_zero() {
        let cache = cache_with_swr(0);
        // Entry is 5s past max_age; with swr_multiplier=0 it should be a miss
        let entry = make_entry(60, 65);
        cache.put("key5", entry).await.unwrap();
        assert!(cache.get("key5", "deploy-1").await.is_none());
    }
}
