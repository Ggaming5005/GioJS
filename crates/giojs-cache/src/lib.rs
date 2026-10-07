//! giojs-cache/src/lib.rs
//!
//! ISR-equivalent page cache with memory LRU + disk persistence and
//! stale-while-revalidate semantics. Redis support is deferred to Phase 3.
//!
//! Lookup order: memory LRU → disk → miss.
//! All writes go to memory immediately and to disk in a background task.
//!
//! On-demand revalidation purges entries by tag or path (see tags.rs): the
//! next request for a purged page is a miss and renders fresh. Fills carry a
//! `FillTicket` so a render that started before a purge cannot store its
//! result after it.

mod backend;
mod disk;
mod key;
mod memory;
mod singleflight;
mod tags;

pub use backend::{CacheBackend, LocalBackend};
pub use disk::is_disk_cache_file;
pub use key::build_cache_key;
pub use singleflight::SingleFlight;
pub use tags::{path_tag, FillTicket, PathMatch, PATH_TAG_PREFIX};

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::SystemTime;

use bytes::Bytes;
use thiserror::Error;

use tags::Invalidation;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub html: Bytes,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub created_at: SystemTime,
    pub max_age_secs: u64,
    pub deployment_id: String,
    /// True when `html` is the final composed document (critical CSS, font
    /// preloads, and deployment script already injected at put time), so it
    /// can be served byte-for-byte on a hit. False for entries written by
    /// older versions or in dev mode - those are injected per request.
    pub composed: bool,
    /// Cache tags: those declared by the render (IPC `cacheTags`) plus the
    /// implicit `path_tag` of the page. `invalidate_tags` and
    /// `invalidate_paths` purge by them.
    pub tags: Vec<String>,
    /// True when `html` is only the static shell of a PPR page (everything
    /// React flushed before the first Suspense boundary). A hit must append a
    /// per-request holes render instead of serving the entry as a full page.
    pub ppr_shell: bool,
    /// The route pattern that rendered the entry (IPC `route`), so hits keep
    /// their metrics label without asking the worker. None when no route
    /// matched or for entries written before routes were stored.
    pub route: Option<String>,
    /// Strong ETag of `html` (a quoted hex digest). Filled in by `put` and
    /// `put_fresh` when None, so the hash is computed once per stored render,
    /// never per hit; disk entries written before ETags existed get it when
    /// loaded.
    pub etag: Option<String>,
}

/// Strong ETag for a stored body: a quoted 128-bit SHA-256 prefix, hex.
pub fn entry_etag(html: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(html);
    let mut etag = String::with_capacity(34);
    etag.push('"');
    for byte in digest.iter().take(16) {
        use std::fmt::Write;
        let _ = write!(etag, "{byte:02x}");
    }
    etag.push('"');
    etag
}

/// Fill in the entry's ETag when the caller left it None: every store path
/// (`put` and the server's `put_fresh` fills) hashes the body once here.
fn with_etag(mut entry: CacheEntry) -> CacheEntry {
    if entry.etag.is_none() {
        entry.etag = Some(entry_etag(&entry.html));
    }
    entry
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheStatus {
    Hit,
    /// Past `max_age` but within `max_age * swr_multiplier` - serve stale,
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

    /// Drop every entry, memory and disk. Dev-mode invalidation: after a
    /// code change, everything previously rendered is stale.
    pub async fn clear(&self) {
        self.backend.clear().await;
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
            // Dead entry from a previous deployment: delete it so it stops
            // occupying an LRU slot and disk space and being re-read on every
            // touch of this key.
            self.backend.remove(key).await;
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
        self.backend.put(key, with_etag(entry)).await
    }

    /// Capture the invalidation sequence before rendering a fill (a miss, a
    /// background refresh, a PPR shell) and hand it to `put_fresh`.
    pub fn fill_ticket(&self) -> FillTicket {
        self.backend.fill_ticket()
    }

    /// `put`, unless an invalidation since `ticket` matches the entry's tags:
    /// the render started before that purge, so its content may predate it.
    /// Returns whether the entry was stored. A dropped write costs one more
    /// miss; storing it would serve purged content until it expired.
    pub async fn put_fresh(
        &self,
        key: &str,
        entry: CacheEntry,
        ticket: FillTicket,
    ) -> Result<bool, CacheError> {
        self.backend.put_fresh(key, with_etag(entry), ticket).await
    }

    /// Purge every entry carrying any of `tags`, from memory and disk (PPR
    /// shells included). The next request for each is a miss. Returns the
    /// number of entries purged.
    pub async fn invalidate_tags<S: AsRef<str>>(&self, tags: &[S]) -> usize {
        if tags.is_empty() {
            return 0;
        }
        let set = tags.iter().map(|tag| tag.as_ref().to_string()).collect();
        self.backend.invalidate(Invalidation::Tags(set)).await
    }

    /// Purge the pages at `paths` (`PathMatch::Exact`) or at and below them
    /// (`PathMatch::Prefix`), every query string and locale of each. Paths
    /// must be in the form the server tags entries with (`path_tag`).
    /// Returns the number of entries purged.
    pub async fn invalidate_paths<S: AsRef<str>>(&self, paths: &[S], kind: PathMatch) -> usize {
        if paths.is_empty() {
            return 0;
        }
        let invalidation = match kind {
            PathMatch::Exact => {
                Invalidation::Tags(paths.iter().map(|path| path_tag(path.as_ref())).collect())
            }
            PathMatch::Prefix => Invalidation::PathPrefixes(
                paths.iter().map(|path| path.as_ref().to_string()).collect(),
            ),
        };
        self.backend.invalidate(invalidation).await
    }

    /// Index the entries a previous run left on disk so invalidations reach
    /// them before they are ever promoted; deletes entries of other
    /// deployments. Run once at startup (in the background is fine: until
    /// it finishes, promotions are checked against every purge since boot).
    pub async fn index_disk(&self, deployment_id: &str) {
        self.backend.index_disk(deployment_id).await;
    }

    /// Drop one entry from memory and disk - e.g. a page whose refresh says
    /// it no longer exists, so its stale copy must stop being served.
    pub async fn remove(&self, key: &str) {
        self.backend.remove(key).await;
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
            composed: false,
            tags: Vec::new(),
            ppr_shell: false,
            route: None,
            etag: None,
        }
    }

    #[tokio::test]
    async fn put_stamps_a_strong_etag_of_the_body_once() {
        let cache = cache_with_swr(10);
        cache.put("etag-key", make_entry(3600, 0)).await.unwrap();
        let (entry, _) = cache.get("etag-key", "deploy-1").await.unwrap();
        let etag = entry.etag.expect("put fills the etag");
        assert_eq!(etag, entry_etag(b"<h1>Test</h1>"));
        assert!(etag.starts_with('"') && etag.ends_with('"') && etag.len() == 34);
        assert_ne!(etag, entry_etag(b"<h1>Other</h1>"));

        // A caller-provided value is kept as-is.
        let mut preset = make_entry(3600, 0);
        preset.etag = Some("\"preset\"".into());
        cache.put("etag-preset", preset).await.unwrap();
        let (entry, _) = cache.get("etag-preset", "deploy-1").await.unwrap();
        assert_eq!(entry.etag.as_deref(), Some("\"preset\""));
    }

    #[tokio::test]
    async fn put_fresh_stamps_the_etag_too() {
        // Every server fill stores through put_fresh: its entries need the
        // ETag that 304 answers compare against.
        let cache = cache_with_swr(10);
        let ticket = cache.fill_ticket();
        assert!(cache
            .put_fresh("etag-fresh", make_entry(3600, 0), ticket)
            .await
            .unwrap());
        let (entry, _) = cache.get("etag-fresh", "deploy-1").await.unwrap();
        assert_eq!(entry.etag, Some(entry_etag(b"<h1>Test</h1>")));
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
    async fn deployment_mismatch_is_a_miss_and_evicts_the_dead_entry() {
        let cache = cache_with_swr(10);
        cache
            .put("key-old-deploy", make_entry(3600, 0))
            .await
            .unwrap();

        assert!(cache.get("key-old-deploy", "deploy-2").await.is_none());
        // The dead entry must be gone, not silently occupying an LRU slot -
        // even a lookup with the original deployment ID now misses.
        assert!(cache.get("key-old-deploy", "deploy-1").await.is_none());
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
    async fn clear_drops_memory_and_disk_entries() {
        let dir = std::env::temp_dir().join(format!("giojs-cache-clear-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let cache = PageCache::new(CacheConfig {
            memory_max_entries: NonZeroUsize::new(100).unwrap(),
            disk_dir: dir.clone(),
            swr_multiplier: 10,
            disk_max_bytes: 0,
        });
        cache.put("key-clear", make_entry(3600, 0)).await.unwrap();
        assert!(cache.get("key-clear", "deploy-1").await.is_some());
        // Give the background disk write a moment to land, then clear.
        tokio::time::sleep(Duration::from_millis(100)).await;
        cache.clear().await;
        assert!(
            cache.get("key-clear", "deploy-1").await.is_none(),
            "cleared entry must not survive via memory or disk promotion"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn remove_drops_memory_and_disk_entries() {
        let dir = std::env::temp_dir().join(format!("giojs-cache-remove-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let cache = PageCache::new(CacheConfig {
            memory_max_entries: NonZeroUsize::new(100).unwrap(),
            disk_dir: dir.clone(),
            swr_multiplier: 10,
            disk_max_bytes: 0,
        });
        cache.put("key-gone", make_entry(60, 65)).await.unwrap();
        cache.put("key-kept", make_entry(60, 65)).await.unwrap();
        // Let the background disk writes land, so remove must clear both layers.
        tokio::time::sleep(Duration::from_millis(100)).await;
        cache.remove("key-gone").await;
        assert!(
            cache.get("key-gone", "deploy-1").await.is_none(),
            "removed entry must not come back via disk promotion"
        );
        assert!(cache.get("key-kept", "deploy-1").await.is_some());
        let _ = tokio::fs::remove_dir_all(&dir).await;
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
    async fn composed_flag_round_trips_through_cache() {
        let cache = cache_with_swr(10);
        let mut entry = make_entry(3600, 0);
        entry.composed = true;
        cache.put("key-composed", entry).await.unwrap();
        let (got, status) = cache.get("key-composed", "deploy-1").await.unwrap();
        assert_eq!(status, CacheStatus::Hit);
        assert!(got.composed);
    }

    #[tokio::test]
    async fn ppr_shell_flag_round_trips_through_cache() {
        let cache = cache_with_swr(10);
        let mut entry = make_entry(3600, 0);
        entry.ppr_shell = true;
        cache.put("key-ppr", entry).await.unwrap();
        let (got, status) = cache.get("key-ppr", "deploy-1").await.unwrap();
        assert_eq!(status, CacheStatus::Hit);
        assert!(got.ppr_shell);
    }

    #[tokio::test]
    async fn swr_disabled_when_multiplier_is_zero() {
        let cache = cache_with_swr(0);
        // Entry is 5s past max_age; with swr_multiplier=0 it should be a miss
        let entry = make_entry(60, 65);
        cache.put("key5", entry).await.unwrap();
        assert!(cache.get("key5", "deploy-1").await.is_none());
    }

    // ── On-demand revalidation ───────────────────────────────────────────────

    fn tagged(tags: &[&str]) -> CacheEntry {
        let mut entry = make_entry(3600, 0);
        entry.tags = tags.iter().map(|tag| tag.to_string()).collect();
        entry
    }

    fn page(path: &str, tags: &[&str]) -> CacheEntry {
        let mut entry = tagged(tags);
        entry.tags.push(path_tag(path));
        entry
    }

    /// A fresh cache directory per test, removed by the returned guard.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("giojs-cache-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            TempDir(dir)
        }

        fn cache(&self, memory_entries: usize) -> PageCache {
            PageCache::new(CacheConfig {
                memory_max_entries: NonZeroUsize::new(memory_entries).unwrap(),
                disk_dir: self.0.clone(),
                swr_multiplier: 10,
                disk_max_bytes: 0,
            })
        }

        fn has_file(&self, key: &str) -> bool {
            self.0.join(format!("{key}.json")).exists()
        }

        /// Background disk writes are spawned tasks: wait until they land.
        async fn wait_for_file(&self, key: &str) {
            for _ in 0..200 {
                if self.has_file(key) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("disk write of {key} never landed");
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn invalidate_tags_purges_only_tagged_entries_from_both_layers() {
        let dir = TempDir::new("inv-tags");
        let cache = dir.cache(100);
        cache.put("a", tagged(&["posts"])).await.unwrap();
        cache.put("b", tagged(&["posts", "post:1"])).await.unwrap();
        cache.put("c", tagged(&["users"])).await.unwrap();
        for key in ["a", "b", "c"] {
            dir.wait_for_file(key).await;
        }

        assert_eq!(cache.invalidate_tags(&["posts"]).await, 2);
        assert!(cache.get("a", "deploy-1").await.is_none());
        assert!(cache.get("b", "deploy-1").await.is_none());
        assert!(
            !dir.has_file("a") && !dir.has_file("b"),
            "disk files are purged too"
        );
        assert!(cache.get("c", "deploy-1").await.is_some());
        assert_eq!(
            cache.invalidate_tags(&["posts"]).await,
            0,
            "nothing left to purge"
        );
        assert_eq!(cache.invalidate_tags::<&str>(&[]).await, 0);
    }

    #[tokio::test]
    async fn entries_evicted_from_memory_stay_purgeable_on_disk() {
        let dir = TempDir::new("inv-disk-only");
        let cache = dir.cache(1);
        cache.put("old", tagged(&["posts"])).await.unwrap();
        dir.wait_for_file("old").await;
        // Capacity 1: this evicts "old" from memory; only its file remains.
        cache.put("new", tagged(&["other"])).await.unwrap();

        assert_eq!(cache.invalidate_tags(&["posts"]).await, 1);
        assert!(!dir.has_file("old"));
        assert!(
            cache.get("old", "deploy-1").await.is_none(),
            "a purged disk-only entry must not be promoted back"
        );
    }

    #[tokio::test]
    async fn promoted_disk_entries_are_indexed_again() {
        let dir = TempDir::new("inv-promote");
        let cache = dir.cache(1);
        cache.put("a", tagged(&["posts"])).await.unwrap();
        dir.wait_for_file("a").await;
        cache.put("b", tagged(&["other"])).await.unwrap(); // evicts "a"
        assert!(
            cache.get("a", "deploy-1").await.is_some(),
            "promoted from disk"
        );
        cache.put("c", tagged(&["other"])).await.unwrap(); // evicts "a" again

        assert_eq!(cache.invalidate_tags(&["posts"]).await, 1);
        assert!(cache.get("a", "deploy-1").await.is_none());
    }

    #[tokio::test]
    async fn startup_index_finds_entries_left_by_a_previous_run() {
        let dir = TempDir::new("inv-restart");
        // The scan only reads files named by cache-key digests.
        let [a, b, dead_key] =
            ["/a", "/b", "/dead"].map(|path| PageCache::build_key("GET", path, ""));
        {
            let previous = dir.cache(100);
            previous.put(&a, tagged(&["posts"])).await.unwrap();
            previous.put(&b, tagged(&["users"])).await.unwrap();
            let mut dead = tagged(&["posts"]);
            dead.deployment_id = "deploy-0".into();
            previous.put(&dead_key, dead).await.unwrap();
            for key in [&a, &b, &dead_key] {
                dir.wait_for_file(key).await;
            }
        }

        let cache = dir.cache(100);
        cache.index_disk("deploy-1").await;
        assert!(
            !dir.has_file(&dead_key),
            "another deployment's file is deleted"
        );
        assert_eq!(cache.invalidate_tags(&["posts"]).await, 1);
        assert!(!dir.has_file(&a));
        assert!(cache.get(&a, "deploy-1").await.is_none());
        assert!(cache.get(&b, "deploy-1").await.is_some());
    }

    #[tokio::test]
    async fn purges_before_the_startup_index_still_reach_old_files() {
        let dir = TempDir::new("inv-before-index");
        {
            let previous = dir.cache(100);
            previous.put("a", tagged(&["posts"])).await.unwrap();
            previous.put("b", tagged(&["users"])).await.unwrap();
            dir.wait_for_file("a").await;
            dir.wait_for_file("b").await;
        }

        // The purge lands before the scan ever ran: neither file is indexed.
        let cache = dir.cache(100);
        assert_eq!(cache.invalidate_tags(&["posts"]).await, 0);
        assert!(
            cache.get("a", "deploy-1").await.is_none(),
            "an unindexed file older than a matching purge is stale"
        );
        assert!(!dir.has_file("a"));
        assert!(cache.get("b", "deploy-1").await.is_some());
    }

    /// Two instances on one cache directory (the default `.gio/cache/pages`
    /// for every process started in the project): files one writes after
    /// the other's startup scan are served by both, not deleted as purged.
    #[tokio::test]
    async fn instances_sharing_a_cache_directory_keep_each_others_files() {
        let dir = TempDir::new("inv-shared");
        let a = dir.cache(100);
        let b = dir.cache(100);
        a.index_disk("deploy-1").await;
        b.index_disk("deploy-1").await;

        a.put("k", tagged(&["posts"])).await.unwrap();
        dir.wait_for_file("k").await;
        assert!(
            b.get("k", "deploy-1").await.is_some(),
            "B serves the file A wrote"
        );
        assert!(dir.has_file("k"), "and leaves it for A");

        // A purge on B still reaches A's files written before it - even
        // one B never read, so never indexed.
        a.put("unseen", tagged(&["posts"])).await.unwrap();
        dir.wait_for_file("unseen").await;
        assert_eq!(b.invalidate_tags(&["posts"]).await, 1, "k, which B indexed");
        assert!(b.get("unseen", "deploy-1").await.is_none());
        assert!(!dir.has_file("unseen"));

        // Rendered after B's purge (the next second): fresh for B too.
        a.put("after", make_entry_tagged(3600, -2, &["posts"]))
            .await
            .unwrap();
        dir.wait_for_file("after").await;
        assert!(b.get("after", "deploy-1").await.is_some());
    }

    fn make_entry_tagged(max_age_secs: u64, age_offset_secs: i64, tags: &[&str]) -> CacheEntry {
        let mut entry = make_entry(max_age_secs, age_offset_secs);
        entry.tags = tags.iter().map(|tag| tag.to_string()).collect();
        entry
    }

    #[tokio::test]
    async fn invalidate_paths_exact_and_prefix() {
        let dir = TempDir::new("inv-paths");
        let cache = dir.cache(100);
        cache.put("blog", page("/blog", &[])).await.unwrap();
        cache.put("blog-1", page("/blog/1", &[])).await.unwrap();
        cache.put("blog-1-q", page("/blog/1", &[])).await.unwrap(); // ?page=2
        cache.put("blogger", page("/blogger", &[])).await.unwrap();
        cache.put("home", page("/", &[])).await.unwrap();

        assert_eq!(
            cache.invalidate_paths(&["/blog/1"], PathMatch::Exact).await,
            2
        );
        assert!(cache.get("blog-1", "deploy-1").await.is_none());
        assert!(cache.get("blog-1-q", "deploy-1").await.is_none());
        assert!(cache.get("blog", "deploy-1").await.is_some());

        cache.put("blog-1", page("/blog/1", &[])).await.unwrap();
        assert_eq!(
            cache.invalidate_paths(&["/blog"], PathMatch::Prefix).await,
            2
        );
        assert!(cache.get("blog", "deploy-1").await.is_none());
        assert!(cache.get("blog-1", "deploy-1").await.is_none());
        assert!(
            cache.get("blogger", "deploy-1").await.is_some(),
            "prefixes match whole segments"
        );
        assert!(cache.get("home", "deploy-1").await.is_some());

        assert_eq!(cache.invalidate_paths(&["/"], PathMatch::Prefix).await, 2);
        assert!(cache.get("home", "deploy-1").await.is_none());
    }

    #[tokio::test]
    async fn ppr_shell_entries_are_purged_like_pages() {
        let cache = cache_with_swr(10);
        let mut shell = page("/feed", &["feed"]);
        shell.ppr_shell = true;
        cache.put("shell", shell).await.unwrap();
        assert_eq!(cache.invalidate_tags(&["feed"]).await, 1);
        assert!(cache.get("shell", "deploy-1").await.is_none());
    }

    /// The write-back race, step by step: a render takes its ticket, an
    /// invalidation lands while it renders, and its result arrives after the
    /// purge. The stale result must not be stored.
    #[tokio::test]
    async fn a_fill_that_started_before_a_purge_is_not_stored_after_it() {
        let dir = TempDir::new("inv-race");
        let cache = dir.cache(100);
        cache
            .put("post", page("/post/1", &["posts"]))
            .await
            .unwrap();

        let in_flight = cache.fill_ticket(); // render starts
        assert_eq!(cache.invalidate_tags(&["posts"]).await, 1); // CMS webhook
        let stored = cache
            .put_fresh("post", page("/post/1", &["posts"]), in_flight)
            .await
            .unwrap(); // render finishes
        assert!(!stored, "the stale render must be dropped");
        assert!(cache.get("post", "deploy-1").await.is_none());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!dir.has_file("post"), "nor written to disk");

        // Path purges race the same way.
        let in_flight = cache.fill_ticket();
        cache.invalidate_paths(&["/post"], PathMatch::Prefix).await;
        let stored = cache
            .put_fresh("post", page("/post/1", &[]), in_flight)
            .await
            .unwrap();
        assert!(!stored);

        // A render that started after the purge stores normally.
        let fresh = cache.fill_ticket();
        assert!(cache
            .put_fresh("post", page("/post/1", &["posts"]), fresh)
            .await
            .unwrap());
        assert!(cache.get("post", "deploy-1").await.is_some());
    }

    #[tokio::test]
    async fn an_unrelated_purge_does_not_drop_a_fill() {
        let cache = cache_with_swr(10);
        let in_flight = cache.fill_ticket();
        cache.invalidate_tags(&["users"]).await;
        cache.invalidate_paths(&["/admin"], PathMatch::Prefix).await;
        assert!(cache
            .put_fresh("post", page("/post/1", &["posts"]), in_flight)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn a_purge_racing_the_disk_write_leaves_no_file_behind() {
        let dir = TempDir::new("inv-disk-race");
        let cache = dir.cache(100);
        // The disk write is still queued (or in flight) when the purge runs;
        // whichever lands first, no file may survive to be promoted later.
        cache.put("a", tagged(&["posts"])).await.unwrap();
        cache.invalidate_tags(&["posts"]).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!dir.has_file("a"));

        let restarted = dir.cache(100);
        restarted.index_disk("deploy-1").await;
        assert!(restarted.get("a", "deploy-1").await.is_none());
    }

    #[tokio::test]
    async fn clear_also_drops_fills_in_flight() {
        let dir = TempDir::new("inv-clear");
        let cache = dir.cache(100);
        let in_flight = cache.fill_ticket();
        cache.clear().await;
        assert!(!cache.put_fresh("k", tagged(&[]), in_flight).await.unwrap());
    }
}
