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
use crate::tags::{unix_secs, DiskAdmission, FillTicket, Invalidation, TagIndex};
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
            .scan_tags(|key, entry_deployment, tags, written_secs| {
                entry_deployment == deployment_id
                    && lock(index).admit_disk_entry(key, tags, written_secs, false)
                        == DiskAdmission::Live
            })
            .await;
        lock(index).mark_disk_indexed();
    }

    fn insert_locked(&self, index: &mut TagIndex, key: &str, entry: CacheEntry) -> u64 {
        let generation = index.insert(key, &entry.tags, unix_secs(entry.created_at));
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

/// What a disk read found once it is checked against the index.
#[derive(Debug)]
enum Promotion {
    /// Indexed and now in memory: serve the file's entry.
    Promoted(CacheEntry),
    /// The key changed while the file was read (stored again, possibly
    /// after a purge, or promoted by another lookup): serve whatever memory
    /// holds now, never the file, which may predate it.
    Superseded(Option<CacheEntry>),
    /// Purged or replaced while it sat on disk: delete the file.
    Stale,
}

impl LocalBackend {
    /// Promote `entry`, read from `key`'s disk file, to memory. `seen` is
    /// the key's record generation taken before the read started: the read
    /// is an await, and a purge followed by a fresh fill can land during it.
    /// Promoting the file then would overwrite the fresh memory entry with
    /// the purged content.
    async fn promote(&self, key: &str, entry: CacheEntry, seen: Option<u64>) -> Option<CacheEntry> {
        let promotion = {
            let mut index = self.index();
            match index.generation(key) {
                Some(current) if Some(current) != seen => {
                    Promotion::Superseded(self.memory.get(key))
                }
                // Indexed before the read, gone now: purged or removed while
                // it was being read.
                None if seen.is_some() => Promotion::Stale,
                _ => match self.memory.get(key) {
                    // Another lookup promoted the same file meanwhile.
                    Some(promoted) => Promotion::Superseded(Some(promoted)),
                    None => match index.admit_disk_entry(
                        key,
                        &entry.tags,
                        unix_secs(entry.created_at),
                        true,
                    ) {
                        DiskAdmission::Live => {
                            if let Some(evicted) = self.memory.put(key.to_string(), entry.clone()) {
                                index.evicted_from_memory(&evicted);
                            }
                            Promotion::Promoted(entry)
                        }
                        DiskAdmission::Stale => Promotion::Stale,
                    },
                },
            }
        };
        match promotion {
            Promotion::Promoted(entry) => Some(entry),
            Promotion::Superseded(current) => current,
            Promotion::Stale => {
                self.disk.remove(key).await;
                None
            }
        }
    }
}

impl CacheBackend for LocalBackend {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        if let Some(entry) = self.memory.get(key) {
            return Some(entry);
        }
        // Promote disk hit to memory - unless the file belongs to an entry
        // that was purged (its removal may still be in flight) or the key
        // was stored again while the file was read.
        let seen = self.index().generation(key);
        let entry = self.disk.get(key).await?;
        self.promote(key, entry, seen).await
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
        // The file first: a removal is not logged like an invalidation, so a
        // file still on disk after its key left the index would read as one
        // another instance wrote, and be promoted back.
        self.disk.remove(key).await;
        let mut index = self.index();
        index.remove(key);
        self.memory.remove(key);
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
            route: None,
            etag: None,
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

    fn page(tag: &str, html: &'static str) -> CacheEntry {
        CacheEntry {
            html: Bytes::from_static(html.as_bytes()),
            ..entry(tag, 0)
        }
    }

    /// The promotion race, step by step: a lookup misses memory and starts
    /// reading the key's disk file; a purge and a fresh fill land while the
    /// read is in flight; the read returns the purged content. It must not
    /// replace the fresh entry in memory, nor be served.
    #[tokio::test]
    async fn a_disk_read_racing_a_purge_and_refill_does_not_restore_the_purged_entry() {
        let dir =
            std::env::temp_dir().join(format!("giojs-backend-promote-race-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let backend = LocalBackend::new(NonZeroUsize::new(1).unwrap(), dir.clone(), 0);
        backend.put("k", page("t", "old")).await.unwrap();
        wait_for_file(&dir, "k").await;
        backend.put("other", entry("u", 8)).await.unwrap(); // evicts "k" from memory

        // get("k"): memory miss, so the file is read...
        assert!(backend.memory.get("k").is_none());
        let seen = backend.index().generation("k");
        let read = backend.disk.get("k").await.expect("the old file");
        // ...while a purge and a render that started after it land.
        let purge = Invalidation::Tags(["t".to_string()].into_iter().collect());
        assert_eq!(backend.invalidate(purge).await, 1);
        let ticket = backend.fill_ticket();
        assert!(backend
            .put_fresh("k", page("t", "fresh"), ticket)
            .await
            .unwrap());

        let served = backend.promote("k", read, seen).await;
        assert_eq!(
            served.map(|entry| entry.html),
            Some(Bytes::from_static(b"fresh")),
            "the lookup is answered with the live entry, not the file it read"
        );
        assert_eq!(
            backend.memory.get("k").map(|entry| entry.html),
            Some(Bytes::from_static(b"fresh")),
            "the purged content did not overwrite the fresh fill"
        );

        // Purged during the read with nothing refilled: a miss, and the
        // file is not promoted back.
        backend.put("other", entry("u", 8)).await.unwrap(); // evicts "k" again
        wait_for_file(&dir, "k").await;
        let seen = backend.index().generation("k");
        let read = backend.disk.get("k").await.expect("the fresh file");
        let purge = Invalidation::Tags(["t".to_string()].into_iter().collect());
        assert_eq!(backend.invalidate(purge).await, 1);
        assert!(backend.promote("k", read, seen).await.is_none());
        assert!(backend.memory.get("k").is_none());
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
