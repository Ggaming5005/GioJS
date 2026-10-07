//! giojs-cache/src/tags.rs
//!
//! Tag index and invalidation log behind on-demand revalidation.
//!
//! The index maps every tag to the cache keys whose entries carry it, for
//! entries in memory AND on disk: an entry evicted from the LRU still has a
//! disk file a later lookup would promote, so it must stay purgeable. Paths
//! are tags too - every cached page carries an implicit `_gio:path:<path>`
//! tag (see `path_tag`), so path revalidation is a tag lookup (exact) or a
//! scan of the path tags (prefix).
//!
//! The log solves the write-back race. A render that started before an
//! invalidation finishes after it with content computed from the old data;
//! storing it would undo the purge. Every fill takes a `FillTicket` (the
//! invalidation sequence number) before it renders, and a put is refused
//! when any later invalidation matches the entry's tags. The log is bounded:
//! a ticket older than the oldest retained event is treated as stale (the
//! write is dropped, the next request renders again - never wrong content).

use std::collections::{HashMap, HashSet, VecDeque};

/// Prefix of the implicit per-path tag. `_gio:` is reserved: the worker
/// refuses user tags that start with it.
pub const PATH_TAG_PREFIX: &str = "_gio:path:";

/// Invalidation events retained once the startup disk scan has indexed
/// every file. Fills older than this many invalidations are dropped.
const LOG_CAP: usize = 1024;
/// Until the disk scan completes, files not yet indexed are checked against
/// every invalidation since boot; past this many events that check gives up
/// and treats un-indexed files as stale.
const BOOT_LOG_CAP: usize = 65_536;

/// The implicit tag every cached page carries for its path.
pub fn path_tag(path: &str) -> String {
    format!("{PATH_TAG_PREFIX}{path}")
}

/// True when `path` is `prefix` or lies below it at a segment boundary:
/// `/blog` covers `/blog` and `/blog/a`, never `/blogger`; `/` covers all.
pub fn path_has_prefix(path: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return true;
    }
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Invalidation sequence number captured before a render starts. Pass it to
/// `PageCache::put_fresh` so a render that raced an invalidation is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FillTicket(pub(crate) u64);

impl FillTicket {
    /// The sequence number itself. Two tickets are equal exactly when no
    /// invalidation happened between them - e.g. to keep renders started on
    /// either side of a purge from being shared.
    pub fn sequence(self) -> u64 {
        self.0
    }
}

/// How `PageCache::invalidate_paths` matches cached pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathMatch {
    /// Only the page at exactly this path (every query string and locale).
    Exact,
    /// The path and everything below it, at segment boundaries.
    Prefix,
}

/// One invalidation, as matched against an entry's tags.
#[derive(Debug, Clone)]
pub(crate) enum Invalidation {
    /// Everything (dev-mode clear).
    All,
    /// Entries carrying any of these tags (exact paths arrive as path tags).
    Tags(HashSet<String>),
    /// Entries whose path tag lies under any of these prefixes.
    PathPrefixes(Vec<String>),
}

impl Invalidation {
    pub(crate) fn matches(&self, tags: &[String]) -> bool {
        match self {
            Invalidation::All => true,
            Invalidation::Tags(set) => tags.iter().any(|tag| set.contains(tag)),
            Invalidation::PathPrefixes(prefixes) => tags.iter().any(|tag| {
                tag.strip_prefix(PATH_TAG_PREFIX)
                    .is_some_and(|path| prefixes.iter().any(|prefix| path_has_prefix(path, prefix)))
            }),
        }
    }
}

#[derive(Debug)]
struct KeyRecord {
    tags: Vec<String>,
    /// Bumped by every put of the key, so a background disk write can tell
    /// whether it still belongs to the live record.
    generation: u64,
    in_memory: bool,
    on_disk: bool,
}

/// What `TagIndex::admit_disk_entry` decided about a file found on disk.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiskAdmission {
    /// Indexed (or already was): serve / keep it.
    Live,
    /// Purged or superseded while it sat on disk: delete the file.
    Stale,
}

#[derive(Debug, Default)]
pub(crate) struct TagIndex {
    /// Sequence number of the latest invalidation (0 = none yet).
    seq: u64,
    log: VecDeque<(u64, Invalidation)>,
    /// Every event with a sequence number <= floor was dropped from the log.
    floor: u64,
    by_tag: HashMap<String, HashSet<String>>,
    records: HashMap<String, KeyRecord>,
    next_generation: u64,
    /// The startup scan has indexed every file that predates this process.
    disk_indexed: bool,
}

impl TagIndex {
    pub(crate) fn ticket(&self) -> FillTicket {
        FillTicket(self.seq)
    }

    /// True when an invalidation after `since` matches `tags`, or when the
    /// log no longer reaches back that far (assume the worst).
    pub(crate) fn invalidated_since(&self, since: u64, tags: &[String]) -> bool {
        if since < self.floor {
            return true;
        }
        self.log
            .iter()
            .rev()
            .take_while(|(seq, _)| *seq > since)
            .any(|(_, invalidation)| invalidation.matches(tags))
    }

    /// Record a put: the entry is now in memory, and its disk write is on
    /// the way. Returns the generation the disk write must carry.
    pub(crate) fn insert(&mut self, key: &str, tags: &[String]) -> u64 {
        self.unlink(key);
        self.next_generation += 1;
        let generation = self.next_generation;
        for tag in tags {
            self.by_tag
                .entry(tag.clone())
                .or_default()
                .insert(key.to_string());
        }
        self.records.insert(
            key.to_string(),
            KeyRecord {
                tags: tags.to_vec(),
                generation,
                in_memory: true,
                on_disk: true,
            },
        );
        generation
    }

    /// The LRU dropped `key`; it stays indexed while its disk file exists.
    pub(crate) fn evicted_from_memory(&mut self, key: &str) {
        if let Some(record) = self.records.get_mut(key) {
            record.in_memory = false;
            if !record.on_disk {
                self.unlink(key);
            }
        }
    }

    /// `key`'s disk file is gone (disk eviction, failed or skipped write).
    /// With `generation`, only when the record is still that put's.
    pub(crate) fn removed_from_disk(&mut self, key: &str, generation: Option<u64>) {
        if let Some(record) = self.records.get_mut(key) {
            if generation.is_some_and(|g| g != record.generation) {
                return;
            }
            record.on_disk = false;
            if !record.in_memory {
                self.unlink(key);
            }
        }
    }

    /// The generation of `key`'s record, None when it is not indexed. A disk
    /// read compares it before and after: a record that changed meanwhile
    /// means the file may predate the live entry.
    pub(crate) fn generation(&self, key: &str) -> Option<u64> {
        self.records.get(key).map(|record| record.generation)
    }

    /// Whether a background disk write of `key` (put at `since` with
    /// `generation`) may land: false once the key was invalidated or
    /// removed after the put.
    pub(crate) fn disk_write_is_live(
        &self,
        key: &str,
        generation: u64,
        since: u64,
        tags: &[String],
    ) -> bool {
        let indexed = self
            .records
            .get(key)
            .is_some_and(|record| record.generation >= generation);
        indexed && !self.invalidated_since(since, tags)
    }

    /// A file of `key` was read from disk (promotion or the startup scan).
    /// A key the index knows is live only while its record says so. An
    /// unknown key is either a file from a previous run that the scan has
    /// not reached yet - live unless an invalidation since boot matches it -
    /// or, once the scan is done, a file whose entry was purged.
    pub(crate) fn admit_disk_entry(
        &mut self,
        key: &str,
        tags: &[String],
        promote: bool,
    ) -> DiskAdmission {
        if let Some(record) = self.records.get_mut(key) {
            if !record.on_disk {
                return DiskAdmission::Stale;
            }
            if promote {
                record.in_memory = true;
            }
            return DiskAdmission::Live;
        }
        if self.disk_indexed || self.invalidated_since(0, tags) {
            return DiskAdmission::Stale;
        }
        self.next_generation += 1;
        let generation = self.next_generation;
        for tag in tags {
            self.by_tag
                .entry(tag.clone())
                .or_default()
                .insert(key.to_string());
        }
        self.records.insert(
            key.to_string(),
            KeyRecord {
                tags: tags.to_vec(),
                generation,
                in_memory: promote,
                on_disk: true,
            },
        );
        DiskAdmission::Live
    }

    pub(crate) fn mark_disk_indexed(&mut self) {
        self.disk_indexed = true;
        self.trim_log();
    }

    /// Log an invalidation and drop every matching key from the index.
    /// Returns the purged keys; the caller removes them from both layers.
    pub(crate) fn invalidate(&mut self, invalidation: Invalidation) -> Vec<String> {
        let keys: Vec<String> = match &invalidation {
            Invalidation::All => self.records.keys().cloned().collect(),
            Invalidation::Tags(tags) => {
                let mut keys = HashSet::new();
                for tag in tags {
                    if let Some(tagged) = self.by_tag.get(tag) {
                        keys.extend(tagged.iter().cloned());
                    }
                }
                keys.into_iter().collect()
            }
            Invalidation::PathPrefixes(_) => {
                let mut keys = HashSet::new();
                for (tag, tagged) in &self.by_tag {
                    if invalidation.matches(std::slice::from_ref(tag)) {
                        keys.extend(tagged.iter().cloned());
                    }
                }
                keys.into_iter().collect()
            }
        };
        self.seq += 1;
        self.log.push_back((self.seq, invalidation));
        self.trim_log();
        for key in &keys {
            self.unlink(key);
        }
        keys
    }

    /// Forget `key` entirely (removed from both layers).
    pub(crate) fn remove(&mut self, key: &str) {
        self.unlink(key);
    }

    #[cfg(test)]
    pub(crate) fn tagged_keys(&self, tag: &str) -> Vec<String> {
        let mut keys: Vec<String> = self
            .by_tag
            .get(tag)
            .map(|keys| keys.iter().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    }

    #[cfg(test)]
    pub(crate) fn indexed_key_count(&self) -> usize {
        self.records.len()
    }

    fn unlink(&mut self, key: &str) {
        let Some(record) = self.records.remove(key) else {
            return;
        };
        for tag in &record.tags {
            if let Some(keys) = self.by_tag.get_mut(tag) {
                keys.remove(key);
                if keys.is_empty() {
                    self.by_tag.remove(tag);
                }
            }
        }
    }

    fn trim_log(&mut self) {
        let cap = if self.disk_indexed {
            LOG_CAP
        } else {
            BOOT_LOG_CAP
        };
        while self.log.len() > cap {
            if let Some((seq, _)) = self.log.pop_front() {
                self.floor = seq;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|tag| tag.to_string()).collect()
    }

    fn tag_set(list: &[&str]) -> Invalidation {
        Invalidation::Tags(list.iter().map(|tag| tag.to_string()).collect())
    }

    #[test]
    fn prefixes_match_whole_segments_only() {
        assert!(path_has_prefix("/blog", "/blog"));
        assert!(path_has_prefix("/blog/a/b", "/blog"));
        assert!(path_has_prefix("/blog/a", "/blog/"));
        assert!(!path_has_prefix("/blogger", "/blog"));
        assert!(path_has_prefix("/anything", "/"));
        assert!(path_has_prefix("/", "/"));
    }

    #[test]
    fn path_prefix_invalidation_reads_only_path_tags() {
        let prefix = Invalidation::PathPrefixes(vec!["/blog".into()]);
        assert!(prefix.matches(&tags(&["posts", "_gio:path:/blog/1"])));
        assert!(
            !prefix.matches(&tags(&["/blog/1"])),
            "a user tag is not a path"
        );
        assert!(!prefix.matches(&tags(&["_gio:path:/blogger"])));
    }

    #[test]
    fn insert_and_invalidate_maintain_both_maps() {
        let mut index = TagIndex::default();
        index.insert("k1", &tags(&["posts", "_gio:path:/a"]));
        index.insert("k2", &tags(&["posts"]));
        assert_eq!(index.tagged_keys("posts"), vec!["k1", "k2"]);

        let mut purged = index.invalidate(tag_set(&["posts"]));
        purged.sort();
        assert_eq!(purged, vec!["k1", "k2"]);
        assert!(index.tagged_keys("posts").is_empty());
        assert!(
            index.tagged_keys("_gio:path:/a").is_empty(),
            "every tag of a purged key is unlinked"
        );
        assert_eq!(index.indexed_key_count(), 0);
    }

    #[test]
    fn reinserting_a_key_replaces_its_old_tags() {
        let mut index = TagIndex::default();
        index.insert("k", &tags(&["old"]));
        index.insert("k", &tags(&["new"]));
        assert!(index.tagged_keys("old").is_empty());
        assert_eq!(index.tagged_keys("new"), vec!["k"]);
    }

    #[test]
    fn a_key_stays_indexed_until_it_leaves_both_layers() {
        let mut index = TagIndex::default();
        index.insert("k", &tags(&["t"]));
        index.evicted_from_memory("k");
        assert_eq!(index.tagged_keys("t"), vec!["k"], "still on disk");
        index.removed_from_disk("k", None);
        assert!(index.tagged_keys("t").is_empty());

        index.insert("k", &tags(&["t"]));
        index.removed_from_disk("k", None);
        assert_eq!(index.tagged_keys("t"), vec!["k"], "still in memory");
        index.evicted_from_memory("k");
        assert_eq!(index.indexed_key_count(), 0);
    }

    #[test]
    fn a_stale_disk_write_does_not_clear_a_newer_record() {
        let mut index = TagIndex::default();
        let first = index.insert("k", &tags(&["t"]));
        index.insert("k", &tags(&["t"]));
        index.removed_from_disk("k", Some(first));
        index.evicted_from_memory("k");
        assert_eq!(
            index.tagged_keys("t"),
            vec!["k"],
            "the newer put's disk file is still expected"
        );
    }

    #[test]
    fn tickets_see_only_later_matching_invalidations() {
        let mut index = TagIndex::default();
        let before = index.ticket();
        index.invalidate(tag_set(&["other"]));
        assert!(!index.invalidated_since(before.0, &tags(&["posts"])));
        index.invalidate(tag_set(&["posts"]));
        assert!(index.invalidated_since(before.0, &tags(&["posts"])));
        let after = index.ticket();
        assert!(!index.invalidated_since(after.0, &tags(&["posts"])));
    }

    #[test]
    fn tickets_older_than_the_log_are_stale() {
        let mut index = TagIndex::default();
        index.mark_disk_indexed();
        let ancient = index.ticket();
        for _ in 0..=LOG_CAP {
            index.invalidate(tag_set(&["noise"]));
        }
        assert!(
            index.invalidated_since(ancient.0, &tags(&["unrelated"])),
            "a ticket the log no longer covers cannot be proven fresh"
        );
    }

    #[test]
    fn unknown_disk_files_are_admitted_until_the_scan_completes() {
        let mut index = TagIndex::default();
        assert_eq!(
            index.admit_disk_entry("prev-run", &tags(&["t"]), true),
            DiskAdmission::Live
        );
        assert_eq!(index.tagged_keys("t"), vec!["prev-run"]);

        index.invalidate(tag_set(&["gone"]));
        assert_eq!(
            index.admit_disk_entry("prev-run-2", &tags(&["gone"]), false),
            DiskAdmission::Stale,
            "a file predating an invalidation that matches it is stale"
        );

        index.mark_disk_indexed();
        assert_eq!(
            index.admit_disk_entry("never-indexed", &tags(&["t"]), true),
            DiskAdmission::Stale,
            "after the scan, an unknown file belongs to a purged entry"
        );
    }

    #[test]
    fn disk_writes_after_an_invalidation_are_refused() {
        let mut index = TagIndex::default();
        let generation = index.insert("k", &tags(&["t"]));
        let since = index.ticket().0;
        assert!(index.disk_write_is_live("k", generation, since, &tags(&["t"])));
        index.invalidate(tag_set(&["t"]));
        assert!(!index.disk_write_is_live("k", generation, since, &tags(&["t"])));
    }
}
