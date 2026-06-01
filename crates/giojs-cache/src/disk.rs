//! giojs-cache/src/disk.rs
//!
//! Disk-backed cache layer. Entries are stored as JSON at
//! `<disk_dir>/<sha256key>.json`. Reads are async; writes are fire-and-forget
//! spawned tasks so they never block the request path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::{CacheEntry, CacheError};

/// Serializable form stored on disk. Uses unix timestamp instead of SystemTime
/// so the JSON is human-readable and stable across platforms.
#[derive(Serialize, Deserialize)]
struct DiskEntry {
    html: String,
    status: u16,
    headers: HashMap<String, String>,
    /// Unix timestamp (seconds since UNIX_EPOCH)
    created_at_secs: u64,
    max_age_secs: u64,
    deployment_id: String,
}

impl From<&CacheEntry> for DiskEntry {
    fn from(e: &CacheEntry) -> Self {
        let created_at_secs = e
            .created_at
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        DiskEntry {
            html: String::from_utf8_lossy(&e.html).into_owned(),
            status: e.status,
            headers: e.headers.clone(),
            created_at_secs,
            max_age_secs: e.max_age_secs,
            deployment_id: e.deployment_id.clone(),
        }
    }
}

impl From<DiskEntry> for CacheEntry {
    fn from(d: DiskEntry) -> Self {
        let created_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(d.created_at_secs);
        CacheEntry {
            html: Bytes::from(d.html.into_bytes()),
            status: d.status,
            headers: d.headers,
            created_at,
            max_age_secs: d.max_age_secs,
            deployment_id: d.deployment_id,
        }
    }
}

pub(crate) struct DiskLayer {
    dir: PathBuf,
}

impl DiskLayer {
    pub(crate) fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn path_for(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    pub(crate) async fn get(&self, key: &str) -> Option<CacheEntry> {
        let path = self.path_for(key);
        let bytes = tokio::fs::read(&path).await.ok()?;
        let disk_entry: DiskEntry = serde_json::from_slice(&bytes).ok()?;
        Some(CacheEntry::from(disk_entry))
    }

    /// Write entry to disk in a spawned task so the caller is never blocked.
    pub(crate) fn write_background(&self, key: String, entry: &CacheEntry) {
        let path = self.path_for(&key);
        let disk_entry = DiskEntry::from(entry);
        tokio::spawn(async move {
            match write_entry(&path, &disk_entry).await {
                Ok(()) => {}
                Err(e) => warn!(key = %key, error = %e, "disk cache write failed"),
            }
        });
    }

    /// Evict the oldest files until total directory size is within `max_bytes`.
    /// Errors on individual files are logged and skipped — eviction is best-effort.
    pub(crate) async fn enforce_limit(&self, max_bytes: u64) {
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total: u64 = 0;

        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let len = meta.len();
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            total += len;
            files.push((entry.path(), len, modified));
        }

        if total <= max_bytes {
            return;
        }

        // Oldest first, so the least-recently-written entries are evicted.
        files.sort_by_key(|(_, _, modified)| *modified);
        for (path, len, _) in files {
            if total <= max_bytes {
                break;
            }
            match tokio::fs::remove_file(&path).await {
                Ok(()) => total = total.saturating_sub(len),
                Err(e) => warn!(path = %path.display(), error = %e, "disk cache eviction failed"),
            }
        }
    }
}

async fn write_entry(path: &Path, entry: &DiskEntry) -> Result<(), CacheError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec(entry)?;
    // Write to a unique temp file then rename so a crash or concurrent write
    // can never leave a partially written (unparseable) cache file behind.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp = path.with_extension(format!("{}.{nanos}.tmp", std::process::id()));
    tokio::fs::write(&tmp, json).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::{Duration, SystemTime};

    fn entry_of_size(n: usize) -> CacheEntry {
        CacheEntry {
            html: Bytes::from("x".repeat(n)),
            status: 200,
            headers: HashMap::new(),
            created_at: SystemTime::now(),
            max_age_secs: 60,
            deployment_id: "d".into(),
        }
    }

    #[tokio::test]
    async fn enforce_limit_evicts_oldest_first() {
        let dir = std::env::temp_dir().join(format!("giojs-disk-evict-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let layer = DiskLayer::new(dir.clone());

        // Three ~1KB entries; write "old" first so it has the earliest mtime.
        write_entry(
            &layer.path_for("old"),
            &DiskEntry::from(&entry_of_size(1024)),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        write_entry(
            &layer.path_for("mid"),
            &DiskEntry::from(&entry_of_size(1024)),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        write_entry(
            &layer.path_for("new"),
            &DiskEntry::from(&entry_of_size(1024)),
        )
        .await
        .unwrap();

        // Cap at ~2KB: the oldest entry must be evicted, the newest kept.
        layer.enforce_limit(2048).await;

        assert!(
            layer.get("old").await.is_none(),
            "oldest entry should be evicted"
        );
        assert!(
            layer.get("new").await.is_some(),
            "newest entry should survive"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
