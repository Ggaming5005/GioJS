//! giojs-cache/src/backend.rs
//!
//! Storage backend abstraction for the page cache. `CacheBackend` is the seam
//! that lets a shared cluster-wide tier (e.g. Redis) slot in later without
//! touching the SWR classification or single-flight logic in `PageCache`.
//! `LocalBackend` is the default node-local implementation: in-memory LRU (L1)
//! over on-disk JSON (L2). See SPEC.md §10 "Multi-Instance Cache Coherence".

use std::future::Future;
use std::num::NonZeroUsize;
use std::path::PathBuf;

use crate::disk::DiskLayer;
use crate::memory::MemoryLayer;
use crate::{CacheEntry, CacheError};

/// Raw entry storage. Holds no TTL / deployment-ID / SWR policy — that lives in
/// `PageCache`. Implementations only store and retrieve entries by key.
pub trait CacheBackend: Send + Sync {
    fn get(&self, key: &str) -> impl Future<Output = Option<CacheEntry>> + Send;
    fn put(
        &self,
        key: &str,
        entry: CacheEntry,
    ) -> impl Future<Output = Result<(), CacheError>> + Send;
    /// (entry_count, total_html_bytes) for observability.
    fn stats(&self) -> (usize, usize);
    fn evict_disk(&self) -> impl Future<Output = ()> + Send;
}

/// Node-local backend: in-memory LRU promoted over disk. This is the only
/// backend in P3-a; a shared backend is added in P3-b.
pub struct LocalBackend {
    memory: MemoryLayer,
    disk: DiskLayer,
    disk_max_bytes: u64,
}

impl LocalBackend {
    pub fn new(memory_max_entries: NonZeroUsize, disk_dir: PathBuf, disk_max_bytes: u64) -> Self {
        Self {
            memory: MemoryLayer::new(memory_max_entries),
            disk: DiskLayer::new(disk_dir),
            disk_max_bytes,
        }
    }
}

impl CacheBackend for LocalBackend {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        if let Some(entry) = self.memory.get(key) {
            return Some(entry);
        }
        // Promote disk hit to memory.
        if let Some(entry) = self.disk.get(key).await {
            self.memory.put(key.to_string(), entry.clone());
            return Some(entry);
        }
        None
    }

    async fn put(&self, key: &str, entry: CacheEntry) -> Result<(), CacheError> {
        self.disk.write_background(key.to_string(), &entry);
        self.memory.put(key.to_string(), entry);
        Ok(())
    }

    fn stats(&self) -> (usize, usize) {
        self.memory.stats()
    }

    async fn evict_disk(&self) {
        if self.disk_max_bytes > 0 {
            self.disk.enforce_limit(self.disk_max_bytes).await;
        }
    }
}
