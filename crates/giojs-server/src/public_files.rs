//! giojs-server/src/public_files.rs
//!
//! Root serving for `public/`: `public/robots.txt` answers at `/robots.txt`
//! (favicon.ico, manifest.json, apple-touch-icon.png, `.well-known/...`)
//! as well as at the long-standing `/public/robots.txt`.
//!
//! Membership comes from an in-memory index built at startup, so the
//! dynamic-request path pays a hash lookup instead of a filesystem stat. The
//! dev watcher refreshes the index on `public/` changes; in production
//! `public/` is a deploy artifact, so files added after startup need a
//! restart. Only paths found by walking `public/` can match - a request that
//! is not byte-for-byte an indexed path (`..`, `//`, symlinks, dotfiles) is
//! never served from here and falls through to the app.
//!
//! A root-served file is the same resource as its `/public/...` URL, so the
//! guards, header rules, and rate limits written for that URL apply to the
//! root alias too (`public_url`, used by the rules and rate-limit layers).

use std::borrow::Cow;
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    response::Response,
};
use tower::Service;
use tower_http::services::ServeDir;
use tracing::warn;

/// Root-served public files keep stable URLs across deploys, so browsers
/// must revalidate (Last-Modified from ServeDir) instead of caching them as
/// immutable the way content-hashed chunks are.
pub const PUBLIC_ROOT_CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

/// Where the whole directory is also mounted (`.nest_service` in main.rs).
pub const PUBLIC_URL_PREFIX: &str = "/public";

/// Bound on indexed paths so a stray giant tree under public/ cannot balloon
/// memory; files past it stay reachable under /public/*.
const MAX_INDEXED_FILES: usize = 100_000;

/// The worker's app-root metadata conventions (giojs-core metadata-routes.ts):
/// the URL each serves and the module basename, `.ts` or `.js`.
const METADATA_ROUTES: [(&str, &str); 3] = [
    ("/sitemap.xml", "sitemap"),
    ("/robots.txt", "robots"),
    ("/manifest.webmanifest", "manifest"),
];

pub struct PublicFiles {
    root: PathBuf,
    serve_dir: ServeDir,
    /// URL paths (`/robots.txt`, `/.well-known/security.txt`), decoded.
    files: RwLock<HashSet<String>>,
}

impl PublicFiles {
    /// Index `root` once. A missing directory yields an empty index.
    pub fn load(root: PathBuf) -> Self {
        let files = scan_public_files(&root);
        Self {
            serve_dir: ServeDir::new(&root),
            root,
            files: RwLock::new(files),
        }
    }

    /// Re-walk public/ after a dev-watch change. Blocking filesystem work -
    /// async callers run this inside `spawn_blocking`.
    pub fn refresh(&self) -> usize {
        let files = scan_public_files(&self.root);
        let count = files.len();
        *self.files.write().unwrap_or_else(|e| e.into_inner()) = files;
        count
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn len(&self) -> usize {
        self.files.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// App-root metadata modules (`app/robots.ts`, ...) whose URL an indexed
    /// public/ file also answers: the file is served before any request
    /// reaches the worker, so the module never runs. Returns
    /// `(url, module path)` pairs for the startup warning.
    pub fn shadowed_metadata_routes(&self, app_dir: &Path) -> Vec<(&'static str, PathBuf)> {
        METADATA_ROUTES
            .iter()
            .filter(|(url, _)| self.contains(url))
            .filter_map(|(url, base)| {
                ["ts", "js"]
                    .iter()
                    .map(|ext| app_dir.join(format!("{base}.{ext}")))
                    .find(|module| module.is_file())
                    .map(|module| (*url, module))
            })
            .collect()
    }

    /// True when the raw (percent-encoded) request path names an indexed file.
    pub fn contains(&self, raw_path: &str) -> bool {
        self.indexed_path(raw_path).is_some()
    }

    /// The `/public/...` URL of the indexed file a raw request path names.
    /// Built from the decoded file path, so a percent-encoded spelling of
    /// the root URL (`/%6Dembers/x`) still maps onto the rules for the file.
    pub fn public_url(&self, raw_path: &str) -> Option<String> {
        self.indexed_path(raw_path)
            .map(|path| format!("{PUBLIC_URL_PREFIX}{path}"))
    }

    fn indexed_path<'p>(&self, raw_path: &'p str) -> Option<Cow<'p, str>> {
        let files = self.files.read().unwrap_or_else(|e| e.into_inner());
        if files.is_empty() {
            return None;
        }
        percent_decode_path(raw_path).filter(|path| files.contains(path.as_ref()))
    }

    /// Serve an indexed file through ServeDir (content type, Last-Modified,
    /// conditional GET, ranges). `None` when the file vanished since it was
    /// indexed, so the caller falls through to the app like any other miss.
    pub fn serve(&self, req: &Request) -> impl Future<Output = Option<Response>> + Send {
        // GET/HEAD carry no body; a header-only copy leaves the original
        // request intact for the fall-through path. Built before the first
        // await because the request body is not Sync.
        let mut probe = Request::new(Body::empty());
        *probe.method_mut() = req.method().clone();
        *probe.uri_mut() = req.uri().clone();
        *probe.version_mut() = req.version();
        *probe.headers_mut() = req.headers().clone();
        let mut serve_dir = self.serve_dir.clone();
        async move {
            let ready =
                std::future::poll_fn(|cx| Service::<Request>::poll_ready(&mut serve_dir, cx)).await;
            let resp = match ready {
                Ok(()) => match serve_dir.call(probe).await {
                    Ok(resp) => resp,
                    Err(never) => match never {},
                },
                Err(never) => match never {},
            };
            if resp.status() == StatusCode::NOT_FOUND {
                return None;
            }
            let mut resp = resp.map(Body::new);
            resp.headers_mut()
                .entry(header::CACHE_CONTROL)
                .or_insert(HeaderValue::from_static(PUBLIC_ROOT_CACHE_CONTROL));
            Some(resp)
        }
    }
}

/// Whether a directory entry under public/ may be served at the site root.
/// Dotfiles never are (`.env`, `.DS_Store`, `.git/`) except the top-level
/// `.well-known/` directory; `_gio/` is the server's internal namespace.
fn entry_is_servable(name: &str, top_level: bool) -> bool {
    if name.starts_with('.') {
        return top_level && name == ".well-known";
    }
    !(top_level && name == "_gio")
}

/// Walk `root` and collect the URL path of every regular file. Symlinks are
/// skipped (entry file types are not followed), so the index can never point
/// outside public/; such files remain reachable under /public/*.
fn scan_public_files(root: &Path) -> HashSet<String> {
    let mut files = HashSet::new();
    let mut dirs = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, url_prefix)) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // Non-UTF-8 names cannot be requested as UTF-8 URLs anyway.
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !entry_is_servable(&name, url_prefix.is_empty()) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let url_path = format!("{url_prefix}/{name}");
            if file_type.is_dir() {
                dirs.push((entry.path(), url_path));
            } else if file_type.is_file() {
                if files.len() >= MAX_INDEXED_FILES {
                    warn!(
                        root = %root.display(),
                        limit = MAX_INDEXED_FILES,
                        "public/ index limit reached - remaining files are served under /public/* only"
                    );
                    return files;
                }
                files.insert(url_path);
            }
        }
    }
    files
}

/// Percent-decode a URL path the way ServeDir does. `None` for malformed
/// escapes or non-UTF-8 results - neither can name an indexed file.
fn percent_decode_path(path: &str) -> Option<Cow<'_, str>> {
    if !path.contains('%') {
        return Some(Cow::Borrowed(path));
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok().map(Cow::Owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_public(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("gio_public_test_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp public dir");
        dir
    }

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, contents).expect("write");
    }

    fn get(path: &str) -> Request {
        Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("request")
    }

    #[test]
    fn indexes_nested_files_but_not_directories() {
        let root = temp_public("nested");
        write(&root, "robots.txt", "User-agent: *");
        write(&root, "images/logo.svg", "<svg/>");
        let public = PublicFiles::load(root.clone());
        assert!(public.contains("/robots.txt"));
        assert!(public.contains("/images/logo.svg"));
        assert!(!public.contains("/images"));
        assert!(!public.contains("/images/"));
        assert!(!public.contains("/"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dotfiles_are_never_indexed_except_well_known() {
        let root = temp_public("dotfiles");
        write(&root, ".env", "SECRET=1");
        write(&root, ".git/config", "[core]");
        write(&root, "nested/.DS_Store", "");
        write(&root, ".well-known/security.txt", "Contact: x");
        write(&root, ".well-known/.hidden", "");
        let public = PublicFiles::load(root.clone());
        assert!(!public.contains("/.env"));
        assert!(!public.contains("/.git/config"));
        assert!(!public.contains("/nested/.DS_Store"));
        assert!(public.contains("/.well-known/security.txt"));
        assert!(!public.contains("/.well-known/.hidden"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn internal_namespace_is_reserved() {
        let root = temp_public("reserved");
        write(&root, "_gio/health", "fake");
        write(&root, "nested/_gio/ok.txt", "fine");
        let public = PublicFiles::load(root.clone());
        assert!(!public.contains("/_gio/health"));
        assert!(public.contains("/nested/_gio/ok.txt"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn traversal_and_non_canonical_paths_never_match() {
        let root = temp_public("traversal");
        write(&root, "robots.txt", "ok");
        write(&root, "a/b.txt", "ok");
        let public = PublicFiles::load(root.clone());
        for path in [
            "/a/../robots.txt",
            "/a/%2e%2e/robots.txt",
            "//robots.txt",
            "/a//b.txt",
            "/./robots.txt",
            "/robots.txt/",
            "/../robots.txt",
        ] {
            assert!(!public.contains(path), "{path} must not match");
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_indexed() {
        let root = temp_public("symlink");
        let outside = temp_public("symlink_outside");
        write(&outside, "secret.txt", "nope");
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leak.txt"))
            .expect("symlink file");
        std::os::unix::fs::symlink(&outside, root.join("dir")).expect("symlink dir");
        let public = PublicFiles::load(root.clone());
        assert!(!public.contains("/leak.txt"));
        assert!(!public.contains("/dir/secret.txt"));
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn percent_encoded_names_match_their_decoded_file() {
        let root = temp_public("encoded");
        write(&root, "hello world.txt", "hi");
        write(&root, "caf\u{e9}.txt", "hi");
        let public = PublicFiles::load(root.clone());
        assert!(public.contains("/hello%20world.txt"));
        assert!(public.contains("/caf%C3%A9.txt"));
        assert!(!public.contains("/hello%2"));
        assert!(!public.contains("/caf%FF.txt"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn public_url_names_the_file_behind_a_root_path() {
        let root = temp_public("public_url");
        write(&root, "members/report.txt", "secret");
        write(&root, "hello world.txt", "hi");
        let public = PublicFiles::load(root.clone());
        assert_eq!(
            public.public_url("/members/report.txt").as_deref(),
            Some("/public/members/report.txt")
        );
        // Encoded spellings resolve to the same file, so to the same rules.
        assert_eq!(
            public.public_url("/%6Dembers/report%2Etxt").as_deref(),
            Some("/public/members/report.txt")
        );
        assert_eq!(
            public.public_url("/hello%20world.txt").as_deref(),
            Some("/public/hello world.txt")
        );
        assert_eq!(public.public_url("/members"), None);
        assert_eq!(public.public_url("/missing.txt"), None);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reports_app_metadata_modules_a_public_file_shadows() {
        let root = temp_public("shadowed_metadata");
        let app = temp_public("shadowed_metadata_app");
        write(&root, "robots.txt", "User-agent: *");
        write(&root, "manifest.webmanifest", "{}");
        write(&app, "robots.ts", "export default {}");
        write(&app, "sitemap.ts", "export default []");
        // A directory with the module's name is not a module.
        std::fs::create_dir_all(app.join("manifest.js")).expect("mkdir");
        let public = PublicFiles::load(root.clone());
        assert_eq!(
            public.shadowed_metadata_routes(&app),
            vec![("/robots.txt", app.join("robots.ts"))]
        );
        std::fs::remove_dir_all(app.join("manifest.js")).expect("rmdir");
        write(&app, "manifest.js", "export default {}");
        assert_eq!(public.shadowed_metadata_routes(&app).len(), 2);
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(app).ok();
    }

    #[test]
    fn missing_directory_yields_empty_index() {
        let public = PublicFiles::load(PathBuf::from("/definitely/not/a/public/dir"));
        assert_eq!(public.len(), 0);
        assert!(!public.contains("/robots.txt"));
    }

    #[test]
    fn refresh_picks_up_added_and_removed_files() {
        let root = temp_public("refresh");
        write(&root, "old.txt", "old");
        let public = PublicFiles::load(root.clone());
        assert!(public.contains("/old.txt"));
        std::fs::remove_file(root.join("old.txt")).expect("remove");
        write(&root, "new.txt", "new");
        assert_eq!(public.refresh(), 1);
        assert!(!public.contains("/old.txt"));
        assert!(public.contains("/new.txt"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn percent_decode_rejects_malformed_escapes() {
        assert_eq!(percent_decode_path("/a%20b").as_deref(), Some("/a b"));
        assert_eq!(percent_decode_path("/plain").as_deref(), Some("/plain"));
        assert!(percent_decode_path("/bad%zz").is_none());
        assert!(percent_decode_path("/short%4").is_none());
    }

    #[tokio::test]
    async fn serve_sets_revalidating_cache_control_and_last_modified() {
        let root = temp_public("serve");
        write(&root, "robots.txt", "User-agent: *\n");
        let public = PublicFiles::load(root.clone());
        let resp = public.serve(&get("/robots.txt")).await.expect("served");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            PUBLIC_ROOT_CACHE_CONTROL
        );
        assert!(resp.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/plain"));
        let last_modified = resp.headers()[header::LAST_MODIFIED].clone();

        // ServeDir's conditional handling answers a revalidation with 304.
        let mut conditional = get("/robots.txt");
        conditional
            .headers_mut()
            .insert(header::IF_MODIFIED_SINCE, last_modified);
        let resp = public.serve(&conditional).await.expect("served");
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn serve_falls_through_when_the_file_vanished() {
        let root = temp_public("vanished");
        write(&root, "gone.txt", "bye");
        let public = PublicFiles::load(root.clone());
        std::fs::remove_file(root.join("gone.txt")).expect("remove");
        assert!(public.contains("/gone.txt"), "index is stale until refresh");
        assert!(public.serve(&get("/gone.txt")).await.is_none());
        std::fs::remove_dir_all(root).ok();
    }
}
