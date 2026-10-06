//! giojs-server/src/dev_watch.rs
//!
//! Dev-watch path policy: which directories to register and which changes
//! matter. The whole project root is watched - pages import from
//! components/, lib/, src/, hooks/ - but dependency, VCS, and build-output
//! trees are kept out of the *registration*, not just filtered: inotify's
//! recursive mode adds one kernel watch per subdirectory, and node_modules
//! alone can exhaust `fs.inotify.max_user_watches`. So the root is watched
//! non-recursively and each non-ignored top-level directory recursively;
//! top-level directories created later are added as they appear.
//!
//! Any change under app/ (the route tree, which pages may read at render
//! time) triggers a restart. Elsewhere only source-like extensions and
//! directories appearing or disappearing do: data files a running app
//! writes into the project (SQLite databases, logs, uploads) must not, or
//! every request would restart the worker that served it.
//!
//! Threading: the notify callback runs on notify's event thread, which is
//! also the thread that services `watch()` calls - so it must never block.
//! It records changes as flags (a burst of any size collapses into one
//! pending batch) and hands new top-level directories to a registration
//! thread that owns the watcher. The debounce task only awaits the flags and
//! never touches the watcher, so a backlog of events can't wedge directory
//! registration, the event thread, or a runtime worker.

use std::collections::BTreeSet;
use std::ops::Bound;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use tokio::sync::Notify;
use tracing::{info, warn};

/// What a debounced batch of changes requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchChange {
    /// Code, config, or CSS: re-transform CSS, restart the worker, reload.
    Source,
    /// public/ only: refresh the root-serving index and reload browsers.
    Public,
}

/// Everything one debounce window saw.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WatchBatch {
    pub source: bool,
    pub public: bool,
}

impl WatchBatch {
    pub fn is_empty(&self) -> bool {
        !self.source && !self.public
    }
}

/// Changes seen since the debounce task last looked. Plain flags: recording
/// never blocks or allocates however far behind the task is (it may be
/// awaiting a worker restart), and no change is ever dropped - a batch only
/// says *what* changed, so any number of events fits in it.
#[derive(Default)]
pub struct PendingChanges {
    source: AtomicBool,
    public: AtomicBool,
    wake: Notify,
}

impl PendingChanges {
    pub fn record(&self, change: WatchChange) {
        let flag = match change {
            WatchChange::Source => &self.source,
            WatchChange::Public => &self.public,
        };
        flag.store(true, Ordering::Release);
        // Stores a permit when the task is busy, so it looks again next time.
        self.wake.notify_one();
    }

    fn take(&self) -> WatchBatch {
        WatchBatch {
            source: self.source.swap(false, Ordering::AcqRel),
            public: self.public.swap(false, Ordering::AcqRel),
        }
    }

    /// Wait for the next change, then until `quiet` passes without another -
    /// editors emit several events per save - and return everything seen.
    pub async fn next_batch(&self, quiet: Duration) -> WatchBatch {
        loop {
            self.wake.notified().await;
            while tokio::time::timeout(quiet, self.wake.notified())
                .await
                .is_ok()
            {}
            let batch = self.take();
            // A wake-up whose change an earlier batch already took.
            if !batch.is_empty() {
                return batch;
            }
        }
    }
}

enum Registration {
    Watch(PathBuf),
    Stop,
}

/// A running dev watch. Dropping it stops the registration thread, which
/// drops the watcher.
pub struct DevWatch {
    changes: Arc<PendingChanges>,
    registrations: mpsc::Sender<Registration>,
    #[cfg_attr(not(test), allow(dead_code))]
    new_dirs_registered: Arc<AtomicUsize>,
}

impl DevWatch {
    /// Watch `root` non-recursively, each non-ignored top-level directory
    /// recursively, and `public_dir` too when it lives outside the root.
    /// All paths are expected in canonical form (see `resolve_dir`).
    pub fn start(root: PathBuf, app_dir: PathBuf, public_dir: PathBuf) -> notify::Result<Self> {
        let changes = Arc::new(PendingChanges::default());
        let (registrations, pending_registrations) = mpsc::channel();
        let mut classifier = EventClassifier::new(root.clone(), app_dir, public_dir.clone());
        let event_changes = Arc::clone(&changes);
        let event_registrations = registrations.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    handle_event(
                        &mut classifier,
                        &event_changes,
                        &event_registrations,
                        &event,
                    );
                }
            })?;
        // The root itself non-recursively: top-level files (gio.toml,
        // middleware.ts, package.json, tsconfig.json) and new top-level dirs.
        notify::Watcher::watch(&mut watcher, &root, notify::RecursiveMode::NonRecursive)?;
        for dir in top_level_watch_dirs(&root) {
            watch_dir_recursive(&mut watcher, &dir);
        }
        if !public_dir.starts_with(&root) && public_dir.is_dir() {
            watch_dir_recursive(&mut watcher, &public_dir);
        }

        let new_dirs_registered = Arc::new(AtomicUsize::new(0));
        let registered = Arc::clone(&new_dirs_registered);
        std::thread::Builder::new()
            .name("gio-dev-watch".into())
            .spawn(move || {
                // watch() waits for notify's event thread; blocking here is
                // fine because the callback on that thread never blocks.
                let mut watcher = watcher;
                while let Ok(Registration::Watch(dir)) = pending_registrations.recv() {
                    info!(dir = %dir.display(), "dev watch: watching new directory");
                    watch_dir_recursive(&mut watcher, &dir);
                    registered.fetch_add(1, Ordering::Release);
                }
            })
            .map_err(notify::Error::io)?;

        Ok(Self {
            changes,
            registrations,
            new_dirs_registered,
        })
    }

    pub fn changes(&self) -> &PendingChanges {
        &self.changes
    }

    #[cfg(test)]
    fn new_dirs_registered(&self) -> usize {
        self.new_dirs_registered.load(Ordering::Acquire)
    }
}

impl Drop for DevWatch {
    fn drop(&mut self) {
        let _ = self.registrations.send(Registration::Stop);
    }
}

/// The notify callback body. Runs on notify's event thread: nothing here may
/// block (the channel is unbounded, the flags are atomics).
fn handle_event(
    classifier: &mut EventClassifier,
    changes: &PendingChanges,
    registrations: &mpsc::Sender<Registration>,
    event: &notify::Event,
) {
    if event.need_rescan() {
        // The kernel queue overflowed and events were lost: anything may
        // have changed.
        changes.record(WatchChange::Source);
        changes.record(WatchChange::Public);
        return;
    }
    for dir in new_top_level_dirs(&classifier.root, event) {
        let _ = registrations.send(Registration::Watch(dir));
    }
    if let Some(change) = classifier.classify(event) {
        changes.record(change);
    }
}

/// Register a recursive watch, explaining the inotify limit when that is
/// what failed - the default `max_user_watches` is small on some distros.
pub fn watch_dir_recursive(watcher: &mut impl notify::Watcher, dir: &Path) {
    if let Err(e) = watcher.watch(dir, notify::RecursiveMode::Recursive) {
        if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
            warn!(
                dir = %dir.display(),
                "dev watch: inotify watch limit reached - edits here go unnoticed; raise fs.inotify.max_user_watches"
            );
        } else {
            warn!(error = %e, dir = %dir.display(), "dev watch: cannot watch directory");
        }
    }
}

/// Canonical form of a directory that may not exist yet (public/ created
/// after startup): canonicalize the parent and re-attach the name.
pub fn resolve_dir(dir: &Path) -> PathBuf {
    if let Ok(resolved) = std::fs::canonicalize(dir) {
        return resolved;
    }
    match (dir.parent(), dir.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| dir.to_path_buf()),
        _ => dir.to_path_buf(),
    }
}

/// Top-level directories holding dependencies or build output. Hidden
/// directories (.git, .gio, .next, .idea, ...) are ignored at every depth.
const IGNORED_TOP_LEVEL_DIRS: [&str; 7] = [
    "node_modules",
    "target",
    "out",
    "dist",
    "build",
    "standalone",
    "coverage",
];

/// Extensions whose edits outside app/ change what the worker renders or
/// bundles.
const SOURCE_EXTENSIONS: [&str; 11] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "css", "toml",
];

/// Bound on tracked directories so a giant data tree cannot balloon memory;
/// past it, a directory moved out of the project is noticed at the next edit.
const MAX_KNOWN_DIRS: usize = 100_000;

/// Whether a directory (or any path component) is outside the watch.
/// `.gio/` is the worker's own output (routes.d.ts, build/) - reacting to it
/// would restart forever.
fn is_ignored_component(name: &str, top_level: bool) -> bool {
    if name == "node_modules" {
        return true;
    }
    if name.starts_with('.') {
        return name != ".well-known";
    }
    top_level && IGNORED_TOP_LEVEL_DIRS.contains(&name)
}

/// Editor scratch files: backups (`foo.tsx~`), vim swap (`.swp`/`.swx`) and
/// its write probe (`4913`), Emacs lock files (`.#foo.tsx`).
fn is_editor_temp_file(name: &str) -> bool {
    name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swx")
        || name == "4913"
        || name.starts_with(".#")
}

fn has_source_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SOURCE_EXTENSIONS.contains(&ext))
}

/// Top-level directories to watch recursively.
pub fn top_level_watch_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    // Names first, so ignored entries are never stat'ed; is_dir() follows
    // symlinks, keeping a linked shared/ or packages/ checkout watched.
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| !is_ignored_component(name, true))
        })
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// Directories this event created directly under the root - they need their
/// own recursive watch, since the root itself is watched non-recursively.
pub fn new_top_level_dirs(root: &Path, event: &notify::Event) -> Vec<PathBuf> {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
    ) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter(|path| path.parent() == Some(root))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !is_ignored_component(name, true))
        })
        .filter(|path| path.is_dir())
        .cloned()
        .collect()
}

/// Event → change classification. Owned by the notify callback - the one
/// place events arrive - so its directory set needs no lock.
pub struct EventClassifier {
    root: PathBuf,
    app_dir: PathBuf,
    public_dir: PathBuf,
    /// Directories inside the watch. A rename's `From` side arrives without
    /// saying whether it was a directory and can no longer be stat'ed; this
    /// set tells a directory moved out of the project (editors "delete" to
    /// the trash that way) from an app renaming one of its data files.
    /// Ordered, so a directory's subtree is one contiguous range.
    known_dirs: BTreeSet<PathBuf>,
}

impl EventClassifier {
    pub fn new(root: PathBuf, app_dir: PathBuf, public_dir: PathBuf) -> Self {
        let mut classifier = Self {
            root,
            app_dir,
            public_dir,
            known_dirs: BTreeSet::new(),
        };
        let root = classifier.root.clone();
        classifier.collect_dirs(&root);
        classifier
    }

    /// The most significant change an event carries, if any.
    pub fn classify(&mut self, event: &notify::Event) -> Option<WatchChange> {
        if matches!(event.kind, EventKind::Access(_)) {
            return None;
        }
        // Every path is visited, even after a Source: a rename's `To` side
        // must still be tracked.
        let mut most_significant = None;
        for path in &event.paths {
            let directory_change = self.track_directory(path, &event.kind);
            match self.classify_path(path, directory_change) {
                Some(WatchChange::Source) => most_significant = Some(WatchChange::Source),
                Some(WatchChange::Public) if most_significant.is_none() => {
                    most_significant = Some(WatchChange::Public);
                }
                _ => {}
            }
        }
        most_significant
    }

    /// Whether this event created, removed, or renamed `path` as a
    /// directory, which moves files in or out without per-file events.
    /// Keeps `known_dirs` in step.
    fn track_directory(&mut self, path: &Path, kind: &EventKind) -> bool {
        match kind {
            // The backend said it was a plain file (inotify's IN_ISDIR).
            EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
            EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_)) => {
                let was_dir = self.forget_dirs_under(path);
                let is_dir = path.is_dir();
                if is_dir {
                    self.remember_dirs_under(path);
                }
                was_dir
                    || is_dir
                    || matches!(
                        kind,
                        EventKind::Create(CreateKind::Folder)
                            | EventKind::Remove(RemoveKind::Folder)
                    )
            }
            _ => false,
        }
    }

    fn classify_path(&self, path: &Path, directory_change: bool) -> Option<WatchChange> {
        let file_name = path.file_name()?.to_str()?;
        if is_editor_temp_file(file_name) {
            return None;
        }
        // public/ may live outside the root (GIO_PUBLIC_DIR); check it first.
        if let Ok(rel) = path.strip_prefix(&self.public_dir) {
            return (!has_ignored_component(rel, false)).then_some(WatchChange::Public);
        }
        let rel = path.strip_prefix(&self.root).ok()?;
        if has_ignored_component(rel, true) {
            return None;
        }
        // app/ is the route tree: pages may read any file there at render
        // time (.md, .svg, .yaml), so every change counts, as it always has.
        (path.starts_with(&self.app_dir) || directory_change || has_source_extension(path))
            .then_some(WatchChange::Source)
    }

    /// Track `dir` and every directory below it, when inside the watch.
    fn remember_dirs_under(&mut self, dir: &Path) {
        let Ok(rel) = dir.strip_prefix(&self.root) else {
            return;
        };
        if rel.as_os_str().is_empty() || has_ignored_component(rel, true) {
            return;
        }
        if self.known_dirs.len() < MAX_KNOWN_DIRS {
            self.known_dirs.insert(dir.to_path_buf());
            self.collect_dirs(dir);
        }
    }

    /// Stop tracking `dir` and everything below it; whether `dir` was known.
    fn forget_dirs_under(&mut self, dir: &Path) -> bool {
        let gone: Vec<PathBuf> = self
            .known_dirs
            .range::<Path, _>((Bound::Included(dir), Bound::Unbounded))
            .take_while(|known| known.starts_with(dir))
            .cloned()
            .collect();
        let was_known = gone.first().is_some_and(|first| first == dir);
        for known in gone {
            self.known_dirs.remove(&known);
        }
        was_known
    }

    /// Walk below `start` (inside the root), skipping ignored directories and
    /// not following symlinks.
    fn collect_dirs(&mut self, start: &Path) {
        let mut pending = vec![start.to_path_buf()];
        while let Some(dir) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let top_level = dir == self.root;
            for entry in entries.flatten() {
                if self.known_dirs.len() >= MAX_KNOWN_DIRS {
                    return;
                }
                if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                    continue;
                }
                let name = entry.file_name();
                if name
                    .to_str()
                    .is_none_or(|name| is_ignored_component(name, top_level))
                {
                    continue;
                }
                let path = entry.path();
                self.known_dirs.insert(path.clone());
                pending.push(path);
            }
        }
    }
}

fn has_ignored_component(rel: &Path, rel_to_root: bool) -> bool {
    rel.components()
        .enumerate()
        .any(|(index, component)| match component {
            Component::Normal(name) => name
                .to_str()
                .is_none_or(|name| is_ignored_component(name, rel_to_root && index == 0)),
            _ => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, RenameMode};

    const ROOT: &str = "/proj";
    const APP: &str = "/proj/app";
    const PUBLIC: &str = "/proj/public";

    fn event(kind: EventKind, path: &str) -> notify::Event {
        notify::Event::new(kind).add_path(PathBuf::from(path))
    }

    fn modify(path: &str) -> notify::Event {
        event(
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            path,
        )
    }

    fn classifier() -> EventClassifier {
        EventClassifier::new(ROOT.into(), APP.into(), PUBLIC.into())
    }

    fn classify(event: &notify::Event) -> Option<WatchChange> {
        classifier().classify(event)
    }

    #[test]
    fn sources_outside_app_trigger_a_restart() {
        for path in [
            "/proj/app/page.tsx",
            "/proj/components/layout/Navbar.tsx",
            "/proj/lib/db.ts",
            "/proj/src/util.js",
            "/proj/hooks/useThing.mjs",
            "/proj/gio.toml",
            "/proj/middleware.ts",
            "/proj/tsconfig.json",
            "/proj/app/globals.css",
        ] {
            assert_eq!(classify(&modify(path)), Some(WatchChange::Source), "{path}");
        }
    }

    #[test]
    fn any_change_under_app_triggers_a_restart() {
        // Pages may read these at render time; the app/-only watcher this
        // replaced restarted for every one of them.
        for path in [
            "/proj/app/blog/post.mdx",
            "/proj/app/docs/intro.md",
            "/proj/app/icon.svg",
            "/proj/app/content.yaml",
            "/proj/app/LICENSE",
        ] {
            assert_eq!(classify(&modify(path)), Some(WatchChange::Source), "{path}");
        }
        // Scratch files and hidden directories stay ignored even there.
        assert_eq!(classify(&modify("/proj/app/page.tsx~")), None);
        assert_eq!(classify(&modify("/proj/app/.cache/x.md")), None);
    }

    #[test]
    fn public_changes_only_refresh_the_index() {
        assert_eq!(
            classify(&modify("/proj/public/robots.txt")),
            Some(WatchChange::Public)
        );
        assert_eq!(
            classify(&modify("/proj/public/.well-known/security.txt")),
            Some(WatchChange::Public)
        );
        // Even source-like extensions under public/ are served, not bundled.
        assert_eq!(
            classify(&modify("/proj/public/styles/globals.css")),
            Some(WatchChange::Public)
        );
        assert_eq!(classify(&modify("/proj/public/.DS_Store")), None);
    }

    #[test]
    fn source_beats_public_within_one_event() {
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(PathBuf::from("/proj/public/a.txt"))
            .add_path(PathBuf::from("/proj/lib/a.ts"));
        assert_eq!(classify(&event), Some(WatchChange::Source));
    }

    #[test]
    fn dependency_vcs_and_build_output_are_ignored() {
        for path in [
            "/proj/node_modules/react/index.js",
            "/proj/packages/ui/node_modules/x/index.js",
            "/proj/.git/index.json",
            "/proj/.gio/routes.d.ts",
            "/proj/.gio/build/static/chunks/route-index-ABC.js",
            "/proj/.next/server.js",
            "/proj/target/debug/foo.json",
            "/proj/out/index.js",
            "/proj/dist/index.js",
            "/proj/build/index.js",
            "/proj/standalone/worker.js",
            "/proj/coverage/coverage-final.json",
            "/proj/.idea/workspace.json",
        ] {
            assert_eq!(classify(&modify(path)), None, "{path}");
        }
    }

    #[test]
    fn build_named_directories_below_the_top_level_still_count() {
        // app/build/page.tsx is a /build route, not build output.
        assert_eq!(
            classify(&modify("/proj/app/build/page.tsx")),
            Some(WatchChange::Source)
        );
        assert_eq!(
            classify(&modify("/proj/components/dist/Button.tsx")),
            Some(WatchChange::Source)
        );
    }

    #[test]
    fn editor_temp_files_are_ignored() {
        for path in [
            "/proj/app/page.tsx~",
            "/proj/app/.page.tsx.swp",
            "/proj/app/.page.tsx.swx",
            "/proj/app/4913",
            "/proj/app/.#page.tsx",
            "/proj/public/robots.txt~",
        ] {
            assert_eq!(classify(&modify(path)), None, "{path}");
        }
    }

    #[test]
    fn data_files_written_by_the_app_never_restart() {
        for path in [
            "/proj/data/app.db",
            "/proj/prisma/dev.db-journal",
            "/proj/logs/server.log",
            "/proj/uploads/photo.png",
        ] {
            assert_eq!(classify(&modify(path)), None, "{path}");
        }
    }

    #[test]
    fn extensionless_data_files_removed_or_renamed_never_restart() {
        // multer's default upload names, session/lock files, temp files
        // renamed into place: plain files, whatever their names.
        let mut classifier = classifier();
        for event in [
            event(
                EventKind::Remove(RemoveKind::File),
                "/proj/uploads/3f2a9c0d",
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                "/proj/data/tmp-1234-abcd",
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                "/proj/data/sessions",
            ),
            event(EventKind::Create(CreateKind::File), "/proj/data/LOCK"),
        ] {
            assert_eq!(classifier.classify(&event), None, "{event:?}");
        }
    }

    #[test]
    fn access_events_are_ignored() {
        let event = event(EventKind::Access(AccessKind::Read), "/proj/app/page.tsx");
        assert_eq!(classify(&event), None);
    }

    #[test]
    fn removed_directories_count_as_source_changes() {
        let removed = event(
            EventKind::Remove(RemoveKind::Folder),
            "/proj/components/old",
        );
        assert_eq!(classify(&removed), Some(WatchChange::Source));
        // Extension-less content edits are not structural.
        assert_eq!(classify(&modify("/proj/LICENSE")), None);
    }

    #[test]
    fn queue_overflow_assumes_everything_changed() {
        let root = temp_root("overflow");
        let changes = PendingChanges::default();
        let (registrations, _pending) = mpsc::channel();
        let mut classifier =
            EventClassifier::new(root.clone(), root.join("app"), root.join("public"));
        let overflow = notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        handle_event(&mut classifier, &changes, &registrations, &overflow);
        assert_eq!(
            changes.take(),
            WatchBatch {
                source: true,
                public: true
            }
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn paths_outside_root_are_ignored() {
        assert_eq!(classify(&modify("/elsewhere/page.tsx")), None);
    }

    #[test]
    fn public_dir_outside_root_is_still_classified() {
        let mut classifier =
            EventClassifier::new(ROOT.into(), APP.into(), PathBuf::from("/srv/assets"));
        assert_eq!(
            classifier.classify(&modify("/srv/assets/logo.svg")),
            Some(WatchChange::Public)
        );
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("gio_watch_test_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp root");
        std::fs::canonicalize(&dir).expect("canonical temp root")
    }

    #[test]
    fn directories_moved_out_of_the_project_count_as_source_changes() {
        let root = temp_root("moved_out");
        std::fs::create_dir_all(root.join("components/old/icons")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        let mut classifier =
            EventClassifier::new(root.clone(), root.join("app"), root.join("public"));
        let moved_out = |path: PathBuf| {
            notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(path)
        };
        // Gone from disk (moved to the trash): only the startup walk knows
        // it was a directory.
        std::fs::rename(root.join("components/old"), root.join("trashed")).expect("rename");
        assert_eq!(
            classifier.classify(&moved_out(root.join("components/old"))),
            Some(WatchChange::Source)
        );
        // Its subtree was forgotten along with it.
        assert_eq!(
            classifier.classify(&moved_out(root.join("components/old/icons"))),
            None
        );
        // Ignored trees were never walked.
        assert!(!classifier
            .known_dirs
            .contains(&root.join("node_modules/pkg")));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn directories_moved_into_the_project_are_tracked() {
        let root = temp_root("moved_in");
        std::fs::create_dir_all(root.join("lib")).expect("mkdir");
        let mut classifier =
            EventClassifier::new(root.clone(), root.join("app"), root.join("public"));
        std::fs::create_dir_all(root.join("lib/vendor/nested")).expect("mkdir");
        let moved_in = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(root.join("lib/vendor"));
        assert_eq!(classifier.classify(&moved_in), Some(WatchChange::Source));
        assert!(classifier
            .known_dirs
            .contains(&root.join("lib/vendor/nested")));

        // Moving the nested directory away is now recognised as structural.
        std::fs::remove_dir_all(root.join("lib/vendor/nested")).expect("rmdir");
        let moved_out = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path(root.join("lib/vendor/nested"));
        assert_eq!(classifier.classify(&moved_out), Some(WatchChange::Source));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn registration_skips_ignored_top_level_dirs() {
        let root = temp_root("register");
        for dir in [
            "app",
            "components",
            "public",
            "node_modules",
            ".git",
            ".gio",
            "target",
            "dist",
            "standalone",
        ] {
            std::fs::create_dir_all(root.join(dir)).expect("mkdir");
        }
        std::fs::write(root.join("gio.toml"), "").expect("write");
        let dirs = top_level_watch_dirs(&root);
        let names: Vec<_> = dirs
            .iter()
            .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["app", "components", "public"]);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn resolve_dir_handles_not_yet_created_directories() {
        let root = temp_root("resolve");
        assert_eq!(resolve_dir(&root.join("public")), root.join("public"));
        std::fs::create_dir_all(root.join("public")).expect("mkdir");
        assert_eq!(resolve_dir(&root.join("public")), root.join("public"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn new_top_level_directories_are_detected() {
        let root = temp_root("newdirs");
        std::fs::create_dir_all(root.join("lib")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules")).expect("mkdir");
        std::fs::create_dir_all(root.join("app/nested")).expect("mkdir");
        let created = |path: PathBuf| {
            notify::Event::new(EventKind::Create(CreateKind::Folder)).add_path(path)
        };
        assert_eq!(
            new_top_level_dirs(&root, &created(root.join("lib"))),
            vec![root.join("lib")]
        );
        assert!(new_top_level_dirs(&root, &created(root.join("node_modules"))).is_empty());
        assert!(new_top_level_dirs(&root, &created(root.join("app/nested"))).is_empty());
        // A created *file* at the top level needs no watch of its own.
        std::fs::write(root.join("README.md"), "").expect("write");
        assert!(new_top_level_dirs(&root, &created(root.join("README.md"))).is_empty());
        // Directories created then classified count as source changes.
        let mut classifier =
            EventClassifier::new(root.clone(), root.join("app"), root.join("public"));
        assert_eq!(
            classifier.classify(&created(root.join("lib"))),
            Some(WatchChange::Source)
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recording_never_blocks_and_bursts_collapse() {
        let changes = PendingChanges::default();
        // Nobody is waiting: this is the debounce task stuck in a restart.
        for _ in 0..100_000 {
            changes.record(WatchChange::Public);
        }
        changes.record(WatchChange::Source);
        assert_eq!(
            changes.take(),
            WatchBatch {
                source: true,
                public: true
            }
        );
        assert!(changes.take().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn changes_within_the_quiet_window_join_one_batch() {
        let changes = Arc::new(PendingChanges::default());
        changes.record(WatchChange::Public);
        let late = Arc::clone(&changes);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            late.record(WatchChange::Source);
        });
        let batch = changes.next_batch(Duration::from_millis(300)).await;
        assert_eq!(
            batch,
            WatchBatch {
                source: true,
                public: true
            }
        );
        // Nothing left over: the next batch waits for a new change.
        let idle = tokio::time::timeout(
            Duration::from_secs(5),
            changes.next_batch(Duration::from_millis(300)),
        )
        .await;
        assert!(idle.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_change_during_processing_starts_the_next_batch() {
        let changes = PendingChanges::default();
        changes.record(WatchChange::Source);
        assert!(changes.next_batch(Duration::from_millis(300)).await.source);
        // Recorded while the task was busy (restarting the worker).
        changes.record(WatchChange::Public);
        assert_eq!(
            changes.next_batch(Duration::from_millis(300)).await,
            WatchBatch {
                source: false,
                public: true
            }
        );
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Regression: the callback used to `blocking_send` into a bounded
    /// channel drained by the debounce task, and that task called
    /// `watch()` for new top-level directories - which waits for the very
    /// thread the callback was blocked on. With more than a channel's worth
    /// of events queued (a git checkout during a worker restart), both
    /// sides waited on each other forever. Here nothing drains the changes
    /// at all, and a new directory must still be registered and live.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_backlog_of_unread_changes_never_blocks_new_directory_registration() {
        let root = temp_root("backlog");
        std::fs::create_dir_all(root.join("app")).expect("mkdir");
        std::fs::create_dir_all(root.join("components")).expect("mkdir");
        let watch = DevWatch::start(root.clone(), root.join("app"), root.join("public"))
            .expect("start watch");
        for i in 0..2_000 {
            std::fs::write(root.join(format!("components/q{i}.json")), "{}").expect("write");
        }
        std::fs::create_dir(root.join("lib")).expect("mkdir lib");
        wait_until("lib/ to be registered", || watch.new_dirs_registered() >= 1);

        // inotify delivers in order: the flood and lib/'s creation were all
        // handled before the registration finished. Clear them, then prove
        // the new directory reports edits.
        watch.changes().take();
        std::fs::write(root.join("lib/probe.ts"), "export {}").expect("write probe");
        wait_until("an edit in lib/ to be seen", || {
            watch.changes().take().source
        });
        drop(watch);
        std::fs::remove_dir_all(root).ok();
    }
}
