//! giojs-image/src/cache.rs
//!
//! Two-layer image cache: tokio::sync::Mutex<LruCache> in front of disk.
//! LRU entry count approximated from 200MB budget at 200KB/image average.

use bytes::Bytes;
use lru::LruCache;
use sha2::{Digest, Sha256};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use tokio::sync::Mutex;

pub struct ImageCache {
    memory: Mutex<LruCache<String, Bytes>>,
    disk_dir: PathBuf,
}

impl ImageCache {
    pub fn new(max_memory_bytes: usize, disk_dir: PathBuf) -> Self {
        let max_entries = (max_memory_bytes / (200 * 1024)).max(1);
        Self {
            memory: Mutex::new(LruCache::new(
                NonZeroUsize::new(max_entries).expect("non-zero"),
            )),
            disk_dir,
        }
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
        let path = self.disk_dir.join(format!("{key}.{ext}"));
        tokio::fs::write(&path, &data).await?;
        self.memory.lock().await.put(key.to_string(), data);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
