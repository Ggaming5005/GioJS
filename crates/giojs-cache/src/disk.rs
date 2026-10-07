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
    /// Defaults to false so entries written before this field existed are
    /// treated as uncomposed and re-injected per request instead of mis-served.
    #[serde(default)]
    composed: bool,
    /// Defaults to empty for entries written before tags existed.
    #[serde(default)]
    tags: Vec<String>,
    /// Defaults to false so entries written before PPR existed are served as
    /// complete pages, never mistaken for a shell awaiting holes.
    #[serde(default)]
    ppr_shell: bool,
    /// Route pattern for metrics; absent in entries written before it existed.
    #[serde(default)]
    route: Option<String>,
    /// Absent in entries written before ETags existed - computed on load.
    #[serde(default)]
    etag: Option<String>,
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
            composed: e.composed,
            tags: e.tags.clone(),
            ppr_shell: e.ppr_shell,
            route: e.route.clone(),
            etag: e.etag.clone(),
        }
    }
}

impl From<DiskEntry> for CacheEntry {
    fn from(d: DiskEntry) -> Self {
        let created_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(d.created_at_secs);
        // Once per load: the loaded entry is promoted into memory with it.
        let etag = d
            .etag
            .unwrap_or_else(|| crate::entry_etag(d.html.as_bytes()));
        CacheEntry {
            html: Bytes::from(d.html.into_bytes()),
            status: d.status,
            headers: d.headers,
            created_at,
            max_age_secs: d.max_age_secs,
            deployment_id: d.deployment_id,
            composed: d.composed,
            tags: d.tags,
            ppr_shell: d.ppr_shell,
            route: d.route,
            etag: Some(etag),
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
    ///
    /// `still_live` is asked before writing and again after the rename: an
    /// invalidation can land while the write is queued or in flight, and a
    /// file written for a purged entry would come back on the next disk
    /// promotion. When the write is skipped, fails, or is undone,
    /// `abandoned` runs so the caller stops expecting the file.
    pub(crate) fn write_background(
        &self,
        key: String,
        entry: &CacheEntry,
        still_live: impl Fn() -> bool + Send + 'static,
        abandoned: impl FnOnce() + Send + 'static,
    ) {
        let path = self.path_for(&key);
        let disk_entry = DiskEntry::from(entry);
        tokio::spawn(async move {
            if !still_live() {
                abandoned();
                return;
            }
            if let Err(e) = write_entry(&path, &disk_entry).await {
                warn!(key = %key, error = %e, "disk cache write failed");
                abandoned();
                return;
            }
            if !still_live() {
                remove_file_logged(&path, &key).await;
                abandoned();
            }
        });
    }

    /// Remove one entry's file. Best-effort.
    pub(crate) async fn remove(&self, key: &str) {
        remove_file_logged(&self.path_for(key), key).await;
    }

    /// Visit the key, deployment id, tags and write time (`created_at_secs`)
    /// of every entry file without keeping the bodies around (index rebuild
    /// at startup). Files `visit` returns false for are deleted; unreadable
    /// files are skipped.
    pub(crate) async fn scan_tags(
        &self,
        mut visit: impl FnMut(&str, &str, &[String], u64) -> bool,
    ) {
        /// Only what the index needs; serde skips the rest of the file.
        #[derive(Deserialize)]
        struct EntryTags {
            deployment_id: String,
            #[serde(default)]
            tags: Vec<String>,
            created_at_secs: u64,
        }

        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Some(key) = entry_key(&path) else {
                continue;
            };
            let Ok(bytes) = tokio::fs::read(&path).await else {
                continue;
            };
            let Ok(meta) = serde_json::from_slice::<EntryTags>(&bytes) else {
                continue;
            };
            if !visit(&key, &meta.deployment_id, &meta.tags, meta.created_at_secs) {
                remove_file_logged(&path, &key).await;
            }
        }
    }

    /// Remove every cache file, including `.tmp` files orphaned by a crash
    /// between temp-write and rename. Best-effort (dev-mode invalidation).
    pub(crate) async fn clear_all(&self) {
        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext == "json" || ext == "tmp")
            {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    warn!(path = %path.display(), error = %e, "disk cache clear failed");
                }
            }
        }
    }

    /// Evict the oldest files until total directory size is within `max_bytes`.
    /// Errors on individual files are logged and skipped - eviction is best-effort.
    /// Returns the keys whose entry files were evicted.
    pub(crate) async fn enforce_limit(&self, max_bytes: u64) -> Vec<String> {
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total: u64 = 0;
        let mut evicted = Vec::new();

        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return evicted;
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
            return evicted;
        }

        // Oldest first, so the least-recently-written entries are evicted.
        files.sort_by_key(|(_, _, modified)| *modified);
        for (path, len, _) in files {
            if total <= max_bytes {
                break;
            }
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {
                    total = total.saturating_sub(len);
                    evicted.extend(entry_key(&path));
                }
                Err(e) => warn!(path = %path.display(), error = %e, "disk cache eviction failed"),
            }
        }
        evicted
    }
}

/// The cache key of an entry file (`<key>.json`); None for temp files and
/// anything else in the directory.
fn entry_key(path: &Path) -> Option<String> {
    if path.extension()? != "json" {
        return None;
    }
    Some(path.file_stem()?.to_str()?.to_string())
}

async fn remove_file_logged(path: &Path, key: &str) {
    if let Err(e) = tokio::fs::remove_file(path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!(key = %key, error = %e, "disk cache remove failed");
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
            composed: false,
            tags: Vec::new(),
            ppr_shell: false,
            route: None,
            etag: None,
        }
    }

    #[test]
    fn legacy_json_without_composed_field_defaults_to_false() {
        let json = r#"{"html":"<h1>x</h1>","status":200,"headers":{},"created_at_secs":0,"max_age_secs":60,"deployment_id":"d"}"#;
        let disk_entry: DiskEntry = serde_json::from_str(json).unwrap();
        let entry = CacheEntry::from(disk_entry);
        assert!(!entry.composed);
        assert!(!entry.ppr_shell, "pre-PPR entries must read as full pages");
        assert_eq!(entry.route, None);
        assert_eq!(
            entry.etag.as_deref(),
            Some(crate::entry_etag(b"<h1>x</h1>").as_str()),
            "entries written before ETags get one when loaded"
        );
    }

    #[test]
    fn route_and_etag_survive_serde_roundtrip() {
        let mut entry = entry_of_size(16);
        entry.route = Some("/posts/:id".into());
        entry.etag = Some("\"abc\"".into());
        let json = serde_json::to_string(&DiskEntry::from(&entry)).unwrap();
        let restored = CacheEntry::from(serde_json::from_str::<DiskEntry>(&json).unwrap());
        assert_eq!(restored.route.as_deref(), Some("/posts/:id"));
        assert_eq!(restored.etag.as_deref(), Some("\"abc\""));
    }

    #[test]
    fn ppr_shell_flag_survives_serde_roundtrip() {
        let mut entry = entry_of_size(16);
        entry.ppr_shell = true;
        let json = serde_json::to_string(&DiskEntry::from(&entry)).unwrap();
        let restored = CacheEntry::from(serde_json::from_str::<DiskEntry>(&json).unwrap());
        assert!(restored.ppr_shell);
    }

    #[test]
    fn composed_flag_survives_serde_roundtrip() {
        let mut entry = entry_of_size(16);
        entry.composed = true;
        let json = serde_json::to_string(&DiskEntry::from(&entry)).unwrap();
        let restored = CacheEntry::from(serde_json::from_str::<DiskEntry>(&json).unwrap());
        assert!(restored.composed);
        assert_eq!(restored.html, entry.html);
        assert_eq!(restored.status, entry.status);
        assert_eq!(restored.max_age_secs, entry.max_age_secs);
        assert_eq!(restored.deployment_id, entry.deployment_id);
    }

    #[tokio::test]
    async fn composed_flag_survives_disk_write_and_read() {
        let dir = std::env::temp_dir().join(format!("giojs-disk-composed-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let layer = DiskLayer::new(dir.clone());

        let mut entry = entry_of_size(32);
        entry.composed = true;
        write_entry(&layer.path_for("composed"), &DiskEntry::from(&entry))
            .await
            .unwrap();

        let restored = layer.get("composed").await.expect("entry should exist");
        assert!(restored.composed);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn clear_all_removes_orphaned_tmp_files() {
        let dir = std::env::temp_dir().join(format!("giojs-disk-clear-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let layer = DiskLayer::new(dir.clone());

        write_entry(&layer.path_for("live"), &DiskEntry::from(&entry_of_size(8)))
            .await
            .unwrap();
        // Same shape write_entry uses, as if a crash landed before the rename.
        let orphan = dir.join("live.123.456.tmp");
        tokio::fs::write(&orphan, b"partial").await.unwrap();

        layer.clear_all().await;

        assert!(
            layer.get("live").await.is_none(),
            "json entry must be cleared"
        );
        assert!(!orphan.exists(), "orphaned tmp file must be cleared");

        let _ = tokio::fs::remove_dir_all(&dir).await;
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
