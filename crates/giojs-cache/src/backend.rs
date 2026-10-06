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
use std::sync::{Arc, Mutex, MutexGuard};

use crate::disk::DiskLayer;
use crate::memory::MemoryLayer;
use crate::tags::{DiskAdmission, FillTicket, Invalidation, TagIndex};
use crate::{CacheEntry, CacheError};

/// Raw entry storage. Holds no TTL / deployment-ID / SWR policy - that lives in
/// `PageCache`. Implementations only store and retrieve entries by key.
pub trait CacheBackend: Send + Sync {
    fn get(&self, key: &str) -> impl Future<Output = Option<CacheEntry>> + Send;
    fn put(
        &self,
        key: &str,
        entry: CacheEntry,
    ) -> impl Future<Output = Result<(), CacheError>> + Send;
    /// Store `entry` unless an invalidation after `ticket` matches its tags.
    /// Returns whether it was stored.
    fn put_fresh(
        &self,
        key: &str,
        entry: CacheEntry,
        ticket: FillTicket,
    ) -> impl Future<Output = Result<bool, CacheError>> + Send;
    /// The current invalidation sequence, taken before a fill renders.
    fn fill_ticket(&self) -> FillTicket;
    /// Remove one entry from every layer (e.g. it belongs to a dead deployment).
    fn remove(&self, key: &str) -> impl Future<Output = ()> + Send;
    /// (entry_count, total_html_bytes) for observability.
    fn stats(&self) -> (usize, usize);
    fn evict_disk(&self) -> impl Future<Output = ()> + Send;
    /// Drop every entry, memory and disk (dev-mode invalidation).
    fn clear(&self) -> impl Future<Output = ()> + Send;
}

/// Node-local backend: in-memory LRU promoted over disk. This is the only
/// backend in P3-a; a shared backend is added in P3-b.
///
/// Lock order: the tag index, then the memory layer. Every change that must
/// be atomic with respect to an invalidation (a put, a disk promotion, the
/// purge itself) holds the index lock across the memory operation, so a
/// purge can never miss an entry that is being inserted at the same time.
pub struct LocalBackend {
    memory: MemoryLayer,
    disk: DiskLayer,
    disk_max_bytes: u64,
    index: Arc<Mutex<TagIndex>>,
}

impl LocalBackend {
    pub fn new(memory_max_entries: NonZeroUsize, disk_dir: PathBuf, disk_max_bytes: u64) -> Self {
        Self {
            memory: MemoryLayer::new(memory_max_entries),
            disk: DiskLayer::new(disk_dir),
            disk_max_bytes,
            index: Arc::new(Mutex::new(TagIndex::default())),
        }
    }

    fn index(&self) -> MutexGuard<'_, TagIndex> {
        lock(&self.index)
    }

    /// Purge every entry `invalidation` matches from the index, memory and
    /// disk. Returns how many entries were purged.
    pub(crate) async fn invalidate(&self, invalidation: Invalidation) -> usize {
        let keys = {
            let mut index = self.index();
            let keys = index.invalidate(invalidation);
            for key in &keys {
                self.memory.remove(key);
            }
            keys
        };
        // Outside the lock: a lookup racing these removals reads the file,
        // finds the key unindexed, and refuses to promote it.
        for key in &keys {
            self.disk.remove(key).await;
        }
        keys.len()
    }

    /// Index every entry file left by a previous run, so tag and path
    /// invalidations reach entries that are only on disk. Files of another
    /// deployment are deleted (they could never be served).
    pub(crate) async fn index_disk(&self, deployment_id: &str) {
        let index = &self.index;
        self.disk
            .scan_tags(|key, entry_deployment, tags| {
                entry_deployment == deployment_id
                    && lock(index).admit_disk_entry(key, tags, false) == DiskAdmission::Live
            })
            .await;
        lock(index).mark_disk_indexed();
    }

    fn insert_locked(&self, index: &mut TagIndex, key: &str, entry: CacheEntry) -> u64 {
        let generation = index.insert(key, &entry.tags);
        if let Some(evicted) = self.memory.put(key.to_string(), entry) {
            index.evicted_from_memory(&evicted);
        }
        generation
    }
}

fn lock(index: &Mutex<TagIndex>) -> MutexGuard<'_, TagIndex> {
    // The guard is never held across an await; recover from poisoning like
    // the memory layer does.
    index.lock().unwrap_or_else(|e| e.into_inner())
}

impl CacheBackend for LocalBackend {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        if let Some(entry) = self.memory.get(key) {
            return Some(entry);
        }
        // Promote disk hit to memory - unless the file belongs to an entry
        // that was purged (its removal may still be in flight).
        let entry = self.disk.get(key).await?;
        let admission = {
            let mut index = self.index();
            let admission = index.admit_disk_entry(key, &entry.tags, true);
            if admission == DiskAdmission::Live {
                if let Some(evicted) = self.memory.put(key.to_string(), entry.clone()) {
                    index.evicted_from_memory(&evicted);
                }
            }
            admission
        };
        match admission {
            DiskAdmission::Live => Some(entry),
            DiskAdmission::Stale => {
                self.disk.remove(key).await;
                None
            }
        }
    }

    async fn put(&self, key: &str, entry: CacheEntry) -> Result<(), CacheError> {
        let ticket = self.fill_ticket();
        self.put_fresh(key, entry, ticket).await.map(|_| ())
    }

    async fn put_fresh(
        &self,
        key: &str,
        entry: CacheEntry,
        ticket: FillTicket,
    ) -> Result<bool, CacheError> {
        let tags = entry.tags.clone();
        let (generation, since) = {
            let mut index = self.index();
            if index.invalidated_since(ticket.0, &tags) {
                return Ok(false);
            }
            let since = index.ticket().0;
            let generation = self.insert_locked(&mut index, key, entry.clone());
            (generation, since)
        };
        let live_index = self.index.clone();
        let abandoned_index = self.index.clone();
        let live_key = key.to_string();
        let abandoned_key = key.to_string();
        self.disk.write_background(
            key.to_string(),
            &entry,
            move || lock(&live_index).disk_write_is_live(&live_key, generation, since, &tags),
            move || lock(&abandoned_index).removed_from_disk(&abandoned_key, Some(generation)),
        );
        Ok(true)
    }

    fn fill_ticket(&self) -> FillTicket {
        self.index().ticket()
    }

    async fn remove(&self, key: &str) {
        {
            let mut index = self.index();
            index.remove(key);
            self.memory.remove(key);
        }
        self.disk.remove(key).await;
    }

    fn stats(&self) -> (usize, usize) {
        self.memory.stats()
    }

    async fn evict_disk(&self) {
        if self.disk_max_bytes > 0 {
            let evicted = self.disk.enforce_limit(self.disk_max_bytes).await;
            let mut index = self.index();
            for key in &evicted {
                index.removed_from_disk(key, None);
            }
        }
    }

    async fn clear(&self) {
        {
            let mut index = self.index();
            // Logged like any invalidation, so a render or disk write still
            // in flight cannot bring a cleared entry back.
            index.invalidate(Invalidation::All);
            self.memory.clear();
        }
        self.disk.clear_all().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::collections::HashMap;
    use std::time::{Duration, SystemTime};

    fn entry(tag: &str, size: usize) -> CacheEntry {
        CacheEntry {
            html: Bytes::from("x".repeat(size)),
            status: 200,
            headers: HashMap::new(),
            created_at: SystemTime::now(),
            max_age_secs: 60,
            deployment_id: "d".into(),
            composed: false,
            tags: vec![tag.to_string()],
            ppr_shell: false,
        }
    }

    async fn wait_for_file(dir: &std::path::Path, key: &str) {
        for _ in 0..200 {
            if dir.join(format!("{key}.json")).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("disk write of {key} never landed");
    }

    #[tokio::test]
    async fn disk_eviction_unindexes_keys_that_left_memory_too() {
        let dir = std::env::temp_dir().join(format!("giojs-backend-evict-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let backend = LocalBackend::new(NonZeroUsize::new(1).unwrap(), dir.clone(), 1);

        backend.put("old", entry("t-old", 2048)).await.unwrap();
        wait_for_file(&dir, "old").await;
        backend.put("new", entry("t-new", 16)).await.unwrap(); // evicts "old" from memory
        wait_for_file(&dir, "new").await;
        assert_eq!(backend.index().tagged_keys("t-old"), vec!["old"]);

        // A 1-byte budget evicts both files; only "new" is still in memory.
        backend.evict_disk().await;
        assert!(
            backend.index().tagged_keys("t-old").is_empty(),
            "a key in neither layer leaves the index"
        );
        assert_eq!(
            backend.index().tagged_keys("t-new"),
            vec!["new"],
            "a key still in memory stays purgeable"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn memory_eviction_of_a_key_without_a_file_unindexes_it() {
        let dir = std::env::temp_dir().join(format!("giojs-backend-lru-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let backend = LocalBackend::new(NonZeroUsize::new(1).unwrap(), dir.clone(), 0);
        backend.put("a", entry("t", 8)).await.unwrap();
        wait_for_file(&dir, "a").await;
        backend.index().removed_from_disk("a", None); // as if disk eviction ran
        backend.put("b", entry("u", 8)).await.unwrap(); // evicts "a" from memory
        assert!(backend.index().tagged_keys("t").is_empty());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
