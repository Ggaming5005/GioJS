//! giojs-font/src/lib.rs
//!
//! Font self-hosting: fetches WOFF2 files at startup (downloaded, or copied
//! from public/) and generates @font-face CSS. HTTP serving is handled by the
//! caller (ServeDir in giojs-server) - this crate owns only fetching and CSS
//! generation.

use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

// ── Public types ──────────────────────────────────────────────────────────────

pub struct FontEntry {
    pub family: String,
    pub url: String,
    pub weight: u16,
    pub style: String,
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Derive the local filename from a font entry: `inter-400-normal.woff2`
/// Family and style are reduced to `[a-z0-9-]` so a hostile config value
/// (`/`, `\`, `..`) cannot escape the fonts directory via `dir.join`.
/// A downloaded font is stored under this name; a local one also carries a
/// hash of its content (see [`download_fonts`]).
pub fn font_filename(entry: &FontEntry) -> String {
    format!("{}.woff2", font_stem(entry))
}

fn font_stem(entry: &FontEntry) -> String {
    format!(
        "{}-{}-{}",
        sanitize_filename_component(&entry.family),
        entry.weight,
        sanitize_filename_component(&entry.style),
    )
}

/// Hex digits of a local font's content hash in its served name.
const CONTENT_HASH_LEN: usize = 8;

fn content_hash(bytes: &[u8]) -> String {
    let hex = format!("{:x}", Sha256::digest(bytes));
    hex[..CONTENT_HASH_LEN].to_string()
}

/// `name` is `<stem>-<content hash>.woff2`: a copy of a local font.
fn is_hashed_copy(name: &str, stem: &str) -> bool {
    name.strip_prefix(stem)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(".woff2"))
        .is_some_and(|hash| {
            hash.len() == CONTENT_HASH_LEN
                && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

fn sanitize_filename_component(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn escape_css_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Fetch every entry's WOFF2 file into `dir` and return the name each one is
/// served under (`/_gio/fonts/<name>`), in entry order. The files are served
/// as immutable, so a name must never get new content:
/// - a `url` with a scheme is downloaded once to [`font_filename`] (an
///   existing file is kept, so only the first start needs the network);
/// - any other `url` names a file in `public_dir`, read on every start and
///   stored as `<family>-<weight>-<style>-<content hash>.woff2`, so an edited
///   file gets a new URL on restart instead of being hidden by browser and
///   CDN caches of the old one.
pub async fn download_fonts(
    entries: &[FontEntry],
    dir: &Path,
    public_dir: &Path,
) -> anyhow::Result<Vec<String>> {
    let mut served = Vec::with_capacity(entries.len());
    let mut local_stems = Vec::new();
    for entry in entries {
        if !entry.url.contains("://") {
            let source = local_font_path(&entry.url, public_dir)?;
            let bytes = tokio::fs::read(&source).await.with_context(|| {
                format!(
                    "font '{}': cannot read {} (url = \"{}\")",
                    entry.family,
                    source.display(),
                    entry.url
                )
            })?;
            let stem = font_stem(entry);
            let name = format!("{stem}-{}.woff2", content_hash(&bytes));
            let path = dir.join(&name);
            // The name pins the content, so a copy of the right length is
            // kept; a shorter one is left over from an interrupted write.
            let complete = tokio::fs::metadata(&path)
                .await
                .is_ok_and(|meta| meta.len() == bytes.len() as u64);
            if !complete {
                tokio::fs::write(&path, &bytes).await?;
            }
            local_stems.push(stem);
            served.push(name);
            continue;
        }
        let name = font_filename(entry);
        let path = dir.join(&name);
        served.push(name);
        if path.exists() {
            continue;
        }
        info!(family = %entry.family, weight = %entry.weight, "downloading font");
        // error_for_status: an error page saved as the .woff2 would be served
        // as the font for good, since an existing file is never re-fetched.
        let bytes = reqwest::get(&entry.url)
            .await
            .and_then(reqwest::Response::error_for_status)
            .with_context(|| format!("font '{}': downloading {} failed", entry.family, entry.url))?
            .bytes()
            .await?;
        tokio::fs::write(&path, bytes).await?;
    }
    remove_stale_copies(dir, &local_stems, &served).await;
    Ok(served)
}

/// Deletes the copies earlier starts made of local fonts whose file has
/// changed since: nothing links to them any more. Best effort - a leftover
/// file is harmless.
async fn remove_stale_copies(dir: &Path, stems: &[String], served: &[String]) {
    if stems.is_empty() {
        return;
    }
    let Ok(mut listing) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(item)) = listing.next_entry().await {
        let file_name = item.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let stale = !served.iter().any(|kept| kept == name)
            && stems.iter().any(|stem| is_hashed_copy(name, stem));
        if stale {
            if let Err(err) = tokio::fs::remove_file(item.path()).await {
                warn!(file = %item.path().display(), error = %err, "cannot remove an outdated font copy");
            }
        }
    }
}

/// A local font `url` is the URL the server serves the file at: public/ is
/// served at the site root and under /public/*, so `/fonts/a.woff2` and
/// `/public/fonts/a.woff2` both name public/fonts/a.woff2. Only plain path
/// segments are accepted, so `..` cannot reach outside public/.
pub fn local_font_path(url: &str, public_dir: &Path) -> anyhow::Result<PathBuf> {
    let relative = url.trim_start_matches('/');
    let relative = Path::new(relative.strip_prefix("public/").unwrap_or(relative));
    let plain = relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    if relative.as_os_str().is_empty() || !plain {
        anyhow::bail!(
            "font url \"{url}\" must be an https:// URL or a file under public/ (e.g. \"/fonts/inter.woff2\")"
        );
    }
    Ok(public_dir.join(relative))
}

/// Generate `@font-face` CSS for all entries; `filenames` are the served
/// names [`download_fonts`] returned for them, in the same order.
pub fn generate_css(entries: &[FontEntry], filenames: &[String]) -> String {
    debug_assert_eq!(entries.len(), filenames.len());
    entries
        .iter()
        .zip(filenames)
        .map(|(e, filename)| {
            // font-style is unquoted in CSS, so it gets the strict [a-z0-9-]
            // filter rather than mere quote escaping.
            format!(
                "@font-face{{font-family:'{}';src:url('/_gio/fonts/{}') format('woff2');font-weight:{};font-style:{};font-display:swap;}}\n",
                escape_css_string(&e.family),
                filename,
                e.weight,
                sanitize_filename_component(&e.style),
            )
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(family: &str, weight: u16, style: &str) -> FontEntry {
        FontEntry {
            family: family.to_string(),
            url: String::new(),
            weight,
            style: style.to_string(),
        }
    }

    #[test]
    fn font_filename_lowercase_hyphenated() {
        let e = entry("Inter", 400, "normal");
        assert_eq!(font_filename(&e), "inter-400-normal.woff2");
    }

    #[test]
    fn font_filename_multi_word_family() {
        let e = entry("Noto Sans", 400, "normal");
        assert_eq!(font_filename(&e), "noto-sans-400-normal.woff2");
    }

    #[test]
    fn generate_css_single_entry() {
        let entries = [entry("Inter", 400, "normal")];
        let css = generate_css(&entries, &["inter-400-normal-0123abcd.woff2".to_string()]);
        assert!(css.contains("@font-face"));
        assert!(css.contains("font-family:'Inter'"));
        assert!(css.contains("url('/_gio/fonts/inter-400-normal-0123abcd.woff2')"));
        assert!(css.contains("font-display:swap"));
        assert!(css.contains("font-weight:400"));
    }

    #[test]
    fn generate_css_empty_returns_empty_string() {
        assert_eq!(generate_css(&[], &[]), "");
    }

    #[test]
    fn font_filename_strips_path_traversal_characters() {
        let e = entry("../../etc/passwd", 400, "no\\rmal");
        let filename = font_filename(&e);
        assert_eq!(filename, "------etc-passwd-400-no-rmal.woff2");
        assert!(!filename.contains('/'));
        assert!(!filename.contains('\\'));
        assert!(!filename.contains(".."));
    }

    #[test]
    fn local_font_urls_resolve_like_the_public_urls_they_are_served_at() {
        let public = Path::new("/srv/app/public");
        for url in ["/fonts/a.woff2", "fonts/a.woff2", "/public/fonts/a.woff2"] {
            assert_eq!(
                local_font_path(url, public).unwrap(),
                public.join("fonts").join("a.woff2"),
                "{url}"
            );
        }
    }

    #[test]
    fn local_font_urls_cannot_leave_public() {
        let public = Path::new("/srv/app/public");
        for url in [
            "/../secret.woff2",
            "/public/../../etc/passwd",
            "fonts/a/../../b",
            "",
            "/",
        ] {
            assert!(local_font_path(url, public).is_err(), "{url}");
        }
    }

    async fn fetch(e: &FontEntry, out: &Path, public: &Path) -> anyhow::Result<Vec<String>> {
        download_fonts(std::slice::from_ref(e), out, public).await
    }

    #[tokio::test]
    async fn an_edited_local_font_is_served_under_a_new_name() {
        let root = std::env::temp_dir().join(format!("gio_font_local_{}", std::process::id()));
        let public = root.join("public");
        let out = root.join("fonts");
        std::fs::create_dir_all(public.join("fonts")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let source = public.join("fonts").join("inter.woff2");
        let mut e = entry("Inter", 400, "normal");
        e.url = "/fonts/inter.woff2".to_string();

        std::fs::write(&source, b"v1").unwrap();
        let v1 = fetch(&e, &out, &public).await.unwrap();
        assert_eq!(v1.len(), 1);
        assert!(is_hashed_copy(&v1[0], "inter-400-normal"), "{}", v1[0]);
        assert_eq!(std::fs::read(out.join(&v1[0])).unwrap(), b"v1");
        // Unchanged file, unchanged URL: a restart keeps browser caches valid.
        assert_eq!(fetch(&e, &out, &public).await.unwrap(), v1);

        // The .woff2 files are cached as immutable, so an edited file must
        // reach browsers under a new URL rather than replace the old one.
        let unrelated = [
            "fonts.css",
            "inter-400-normal.woff2",
            "inter-700-normal-0123abcd.woff2",
        ];
        for name in unrelated {
            std::fs::write(out.join(name), b"keep").unwrap();
        }
        std::fs::write(&source, b"v2").unwrap();
        let v2 = fetch(&e, &out, &public).await.unwrap();
        assert_ne!(v2, v1);
        assert!(is_hashed_copy(&v2[0], "inter-400-normal"), "{}", v2[0]);
        assert_eq!(std::fs::read(out.join(&v2[0])).unwrap(), b"v2");
        assert!(!out.join(&v1[0]).exists(), "the outdated copy is removed");
        for name in unrelated {
            assert!(out.join(name).exists(), "{name} is left alone");
        }

        // A copy cut short by an interrupted write is written again.
        std::fs::write(out.join(&v2[0]), b"v").unwrap();
        assert_eq!(fetch(&e, &out, &public).await.unwrap(), v2);
        assert_eq!(std::fs::read(out.join(&v2[0])).unwrap(), b"v2");

        e.url = "/fonts/missing.woff2".to_string();
        let err = fetch(&e, &out, &public).await.unwrap_err();
        assert!(format!("{err:#}").contains("missing.woff2"), "{err:#}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn hashed_copies_are_recognized_by_stem_and_hash() {
        let stem = "inter-400-normal";
        assert!(is_hashed_copy("inter-400-normal-0123abcd.woff2", stem));
        for name in [
            "inter-400-normal.woff2",
            "inter-400-normal-0123ABCD.woff2",
            "inter-400-normal-0123abc.woff2",
            "inter-400-normal-0123abcde.woff2",
            "inter-400-normal-0123abcd.woff",
            "inter-400-normalx0123abcd.woff2",
            "noto-inter-400-normal-0123abcd.woff2",
        ] {
            assert!(!is_hashed_copy(name, stem), "{name}");
        }
        assert_eq!(content_hash(b"v1"), content_hash(b"v1"));
        assert_ne!(content_hash(b"v1"), content_hash(b"v2"));
        assert_eq!(content_hash(b"v1").len(), CONTENT_HASH_LEN);
    }

    #[test]
    fn generate_css_escapes_quotes_and_backslashes_in_family() {
        let entries = [entry("Ev'il\\Font", 400, "normal';}bad")];
        let css = generate_css(&entries, &[font_filename(&entries[0])]);
        assert!(css.contains("font-family:'Ev\\'il\\\\Font'"));
        assert!(css.contains("font-style:normal---bad;"));
        // Exactly one rule: the payload must not close the declaration early.
        assert_eq!(css.matches('}').count(), 1);
    }
}
