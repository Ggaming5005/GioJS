//! giojs-cache/src/memory.rs
//!
//! In-memory LRU cache layer. Wraps the `lru` crate behind a Mutex so it
//! can be shared across async tasks. Eviction is by entry count; byte-based
//! eviction is deferred to Phase 3.
//!
//! A std Mutex (not tokio) is correct here: the guard is never held across an
//! `.await`, so async runtime starvation is impossible. Lock poisoning is
//! recovered from rather than propagated as a panic on the request path.

use std::num::NonZeroUsize;
use std::sync::Mutex;

use lru::LruCache;

use crate::CacheEntry;

pub(crate) struct MemoryLayer {
    inner: Mutex<LruCache<String, CacheEntry>>,
}

impl MemoryLayer {
    pub(crate) fn new(capacity: NonZeroUsize) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(capacity)),
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<CacheEntry> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(key).cloned()
    }

    pub(crate) fn put(&self, key: String, entry: CacheEntry) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.put(key, entry);
    }

    pub(crate) fn stats(&self) -> (usize, usize) {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let count = guard.len();
        let size_bytes: usize = guard.iter().map(|(_, e)| e.html.len()).sum();
        (count, size_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CacheEntry;
    use bytes::Bytes;
    use std::collections::HashMap;
    use std::time::SystemTime;

    fn make_entry(html: &str) -> CacheEntry {
        CacheEntry {
            html: Bytes::from(html.to_string()),
            status: 200,
            headers: HashMap::new(),
            created_at: SystemTime::now(),
            max_age_secs: 60,
            deployment_id: "test-deploy".to_string(),
        }
    }

    #[test]
    fn get_returns_none_on_empty_cache() {
        let layer = MemoryLayer::new(NonZeroUsize::new(10).unwrap());
        assert!(layer.get("missing").is_none());
    }

    #[test]
    fn put_then_get_returns_entry() {
        let layer = MemoryLayer::new(NonZeroUsize::new(10).unwrap());
        layer.put("key1".to_string(), make_entry("<h1>Hello</h1>"));
        let entry = layer.get("key1").expect("entry should be present");
        assert_eq!(entry.html, Bytes::from("<h1>Hello</h1>"));
    }

    #[test]
    fn lru_evicts_oldest_entry_at_capacity() {
        let layer = MemoryLayer::new(NonZeroUsize::new(2).unwrap());
        layer.put("a".to_string(), make_entry("a"));
        layer.put("b".to_string(), make_entry("b"));
        // Access "a" so "b" becomes the LRU
        layer.get("a");
        // Insert "c" — should evict "b"
        layer.put("c".to_string(), make_entry("c"));
        assert!(layer.get("a").is_some());
        assert!(layer.get("b").is_none());
        assert!(layer.get("c").is_some());
    }
}
