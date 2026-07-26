//! giojs-image/src/cache.rs
//!
//! Two-layer image cache: tokio::sync::Mutex<LruCache> in front of disk.
//! LRU entry count approximated from 200MB budget at 200KB/image average.
//! Disk usage is bounded by `disk_max_bytes`: an amortized scan on `put`
//! evicts oldest-modified files (via spawn_blocking) until under the cap.

use bytes::Bytes;
use lru::LruCache;
use sha2::{Digest, Sha256};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;
use tokio::sync::Mutex;
use tracing::{debug, warn};

const DEFAULT_DISK_MAX_BYTES: u64 = 512 * 1024 * 1024;

pub struct ImageCache {
    memory: Mutex<LruCache<String, Bytes>>,
    disk_dir: PathBuf,
    disk_max_bytes: u64,
    // Amortizes eviction: full directory scan only after ~5% of the cap is written.
    bytes_written_since_scan: AtomicU64,
}

impl ImageCache {
    pub fn new(max_memory_bytes: usize, disk_dir: PathBuf) -> Self {
        Self::with_limits(max_memory_bytes, disk_dir, DEFAULT_DISK_MAX_BYTES)
    }

    pub fn with_limits(max_memory_bytes: usize, disk_dir: PathBuf, disk_max_bytes: u64) -> Self {
        let max_entries = (max_memory_bytes / (200 * 1024)).max(1);
        Self {
            memory: Mutex::new(LruCache::new(
                NonZeroUsize::new(max_entries).unwrap_or(NonZeroUsize::MIN),
            )),
            disk_dir,
            disk_max_bytes,
            bytes_written_since_scan: AtomicU64::new(0),
        }
    }

    pub(crate) fn set_disk_max_bytes(&mut self, disk_max_bytes: u64) {
        self.disk_max_bytes = disk_max_bytes;
    }

    pub fn cache_key(src: &str, width: Option<u32>, quality: u8, format: &str) -> String {
        let mut h = Sha256::new();
        h.update(src.as_bytes());
        h.update(b"\0");
        h.update(width.unwrap_or(0).to_be_bytes());
        h.update(b"\0");
        h.update([quality]);
        h.update(b"\0");
        h.update(format.as_bytes());
        h.finalize()
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    pub async fn get(&self, key: &str, ext: &str) -> Option<Bytes> {
        {
            let mut cache = self.memory.lock().await;
            if let Some(data) = cache.get(key) {
                return Some(data.clone());
            }
        }
        let path = self.disk_dir.join(format!("{key}.{ext}"));
        let data = tokio::fs::read(&path).await.ok().map(Bytes::from)?;
        self.memory.lock().await.put(key.to_string(), data.clone());
        Some(data)
    }

    pub async fn put(&self, key: &str, ext: &str, data: Bytes) -> anyhow::Result<()> {
        let data_len = data.len() as u64;
        let path = self.disk_dir.join(format!("{key}.{ext}"));
        tokio::fs::write(&path, &data).await?;
        self.memory.lock().await.put(key.to_string(), data);
        self.maybe_enforce_disk_limit(data_len).await;
        Ok(())
    }

    /// Scan and evict only after enough bytes have accumulated since the last
    /// scan (5% of the cap), keeping `put` cheap in the common case.
    async fn maybe_enforce_disk_limit(&self, bytes_written: u64) {
        if self.disk_max_bytes == 0 {
            return;
        }
        let scan_threshold = (self.disk_max_bytes / 20).max(1);
        let accumulated = self
            .bytes_written_since_scan
            .fetch_add(bytes_written, Ordering::Relaxed)
            .saturating_add(bytes_written);
        if accumulated < scan_threshold {
            return;
        }
        self.bytes_written_since_scan.store(0, Ordering::Relaxed);

        let dir = self.disk_dir.clone();
        let cap = self.disk_max_bytes;
        match tokio::task::spawn_blocking(move || evict_oldest_over_cap(&dir, cap)).await {
            Ok(Ok(removed)) if removed > 0 => {
                debug!(removed, cap, "image disk cache evicted files");
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!(error = %e, "image disk cache eviction failed"),
            Err(e) => warn!(error = %e, "image disk cache eviction task failed"),
        }
    }
}

/// Delete oldest-modified files in `dir` until total size is at most `cap`.
/// Returns the number of files removed.
fn evict_oldest_over_cap(dir: &Path, cap: u64) -> std::io::Result<usize> {
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total_bytes: u64 = 0;
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(metadata.len());
        files.push((entry.path(), metadata.len(), modified));
    }
    if total_bytes <= cap {
        return Ok(0);
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut removed = 0usize;
    for (path, len, _) in files {
        if total_bytes <= cap {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(len);
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gio_image_cache_test_{}_{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cache_key_deterministic() {
        let k1 = ImageCache::cache_key("/hero.jpg", Some(1200), 75, "webp");
        let k2 = ImageCache::cache_key("/hero.jpg", Some(1200), 75, "webp");
        assert_eq!(k1, k2);
    }

    #[test]
    fn cache_key_differs_by_format() {
        let k1 = ImageCache::cache_key("/hero.jpg", Some(1200), 75, "webp");
        let k2 = ImageCache::cache_key("/hero.jpg", Some(1200), 75, "avif");
        assert_ne!(k1, k2);
    }

    #[test]
    fn cache_key_differs_by_width() {
        let k1 = ImageCache::cache_key("/hero.jpg", Some(640), 75, "webp");
        let k2 = ImageCache::cache_key("/hero.jpg", Some(1200), 75, "webp");
        assert_ne!(k1, k2);
    }

    #[tokio::test]
    async fn eviction_removes_oldest_files_when_over_cap() {
        let dir = unique_test_dir("evict_oldest");
        let cache = ImageCache::with_limits(1024 * 1024, dir.clone(), 100);

        cache
            .put("aaa", "webp", Bytes::from(vec![0u8; 60]))
            .await
            .unwrap();
        // Ensure distinct mtimes even on coarse-granularity filesystems.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        cache
            .put("bbb", "webp", Bytes::from(vec![0u8; 60]))
            .await
            .unwrap();

        assert!(
            !dir.join("aaa.webp").exists(),
            "oldest file should be evicted once total exceeds the cap"
        );
        assert!(
            dir.join("bbb.webp").exists(),
            "newest file should survive eviction"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn no_eviction_when_under_cap() {
        let dir = unique_test_dir("under_cap");
        let cache = ImageCache::with_limits(1024 * 1024, dir.clone(), 10_000);

        cache
            .put("aaa", "webp", Bytes::from(vec![0u8; 600]))
            .await
            .unwrap();
        cache
            .put("bbb", "webp", Bytes::from(vec![0u8; 600]))
            .await
            .unwrap();

        assert!(dir.join("aaa.webp").exists());
        assert!(dir.join("bbb.webp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
