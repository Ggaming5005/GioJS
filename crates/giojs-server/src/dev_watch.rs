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
//! Only source-like extensions trigger a restart. Data files a running app
//! writes into the project (SQLite databases, logs, uploads) must not, or
//! every request would restart the worker that served it.

use std::path::{Component, Path, PathBuf};

use notify::event::{EventKind, ModifyKind};
use tracing::{info, warn};

/// What a debounced batch of changes requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchChange {
    /// Code, config, or CSS: re-transform CSS, restart the worker, reload.
    Source,
    /// public/ only: refresh the root-serving index and reload browsers.
    Public,
}

/// Watcher-thread → debounce-task message.
#[derive(Debug)]
pub enum WatchSignal {
    Change(WatchChange),
    /// A top-level directory appeared and needs its own recursive watch.
    NewDir(PathBuf),
}

/// Everything one debounce window saw.
#[derive(Debug, Default)]
pub struct WatchBatch {
    pub source: bool,
    pub public: bool,
}

impl WatchBatch {
    pub fn absorb(&mut self, signal: WatchSignal, watcher: &mut impl notify::Watcher) {
        match signal {
            WatchSignal::Change(WatchChange::Source) => self.source = true,
            WatchSignal::Change(WatchChange::Public) => self.public = true,
            WatchSignal::NewDir(dir) => {
                info!(dir = %dir.display(), "dev watch: watching new directory");
                watch_dir_recursive(watcher, &dir);
            }
        }
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

/// Extensions whose edits change what the worker renders or bundles.
const SOURCE_EXTENSIONS: [&str; 11] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "css", "toml",
];

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

/// The most significant change an event carries, if any.
pub fn classify_event(
    root: &Path,
    public_dir: &Path,
    event: &notify::Event,
) -> Option<WatchChange> {
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    event
        .paths
        .iter()
        .filter_map(|path| classify_path(root, public_dir, path, &event.kind))
        .max_by_key(|change| match change {
            WatchChange::Source => 1,
            WatchChange::Public => 0,
        })
}

fn classify_path(
    root: &Path,
    public_dir: &Path,
    path: &Path,
    kind: &EventKind,
) -> Option<WatchChange> {
    let file_name = path.file_name()?.to_str()?;
    if is_editor_temp_file(file_name) {
        return None;
    }
    // public/ may live outside the root (GIO_PUBLIC_DIR); check it first.
    if let Ok(rel) = path.strip_prefix(public_dir) {
        return (!has_ignored_component(rel, false)).then_some(WatchChange::Public);
    }
    let rel = path.strip_prefix(root).ok()?;
    if has_ignored_component(rel, true) {
        return None;
    }
    let is_source = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SOURCE_EXTENSIONS.contains(&ext));
    if is_source {
        return Some(WatchChange::Source);
    }
    // A directory moved or checked out into the tree arrives with its files
    // already inside (no per-file events), and a removed or renamed path can
    // no longer be stat'ed - it may have been a directory of sources.
    if path.extension().is_none() {
        let structural = match kind {
            EventKind::Create(_) => path.is_dir(),
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => true,
            _ => false,
        };
        if structural {
            return Some(WatchChange::Source);
        }
    }
    None
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
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};

    const ROOT: &str = "/proj";
    const PUBLIC: &str = "/proj/public";

    fn modify(path: &str) -> notify::Event {
        notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(PathBuf::from(path))
    }

    fn classify(event: &notify::Event) -> Option<WatchChange> {
        classify_event(Path::new(ROOT), Path::new(PUBLIC), event)
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
    fn access_events_are_ignored() {
        let event = notify::Event::new(EventKind::Access(notify::event::AccessKind::Read))
            .add_path(PathBuf::from("/proj/app/page.tsx"));
        assert_eq!(classify(&event), None);
    }

    #[test]
    fn removed_or_renamed_directories_count_as_source_changes() {
        let removed = notify::Event::new(EventKind::Remove(RemoveKind::Folder))
            .add_path(PathBuf::from("/proj/components/old"));
        assert_eq!(classify(&removed), Some(WatchChange::Source));
        let renamed = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path(PathBuf::from("/proj/lib/legacy"));
        assert_eq!(classify(&renamed), Some(WatchChange::Source));
        // Extension-less content edits are not structural.
        assert_eq!(classify(&modify("/proj/LICENSE")), None);
    }

    #[test]
    fn paths_outside_root_are_ignored() {
        assert_eq!(classify(&modify("/elsewhere/page.tsx")), None);
    }

    #[test]
    fn public_dir_outside_root_is_still_classified() {
        let event = modify("/srv/assets/logo.svg");
        assert_eq!(
            classify_event(Path::new(ROOT), Path::new("/srv/assets"), &event),
            Some(WatchChange::Public)
        );
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("gio_watch_test_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    #[test]
    fn batches_merge_signals_and_register_new_dirs() {
        let mut watcher = notify::NullWatcher;
        let mut batch = WatchBatch::default();
        batch.absorb(WatchSignal::Change(WatchChange::Public), &mut watcher);
        assert!(batch.public && !batch.source);
        batch.absorb(
            WatchSignal::NewDir(PathBuf::from("/proj/lib")),
            &mut watcher,
        );
        assert!(!batch.source, "registration alone is not a change");
        batch.absorb(WatchSignal::Change(WatchChange::Source), &mut watcher);
        assert!(batch.public && batch.source);
    }

    #[test]
    fn resolve_dir_handles_not_yet_created_directories() {
        let root = temp_root("resolve");
        let canonical_root = std::fs::canonicalize(&root).expect("canonical");
        assert_eq!(
            resolve_dir(&root.join("public")),
            canonical_root.join("public")
        );
        std::fs::create_dir_all(root.join("public")).expect("mkdir");
        assert_eq!(
            resolve_dir(&root.join("public")),
            canonical_root.join("public")
        );
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
        assert_eq!(
            classify_event(&root, &root.join("public"), &created(root.join("lib"))),
            Some(WatchChange::Source)
        );
        std::fs::remove_dir_all(root).ok();
    }
}
