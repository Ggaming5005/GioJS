//! giojs-font/src/lib.rs
//!
//! Font self-hosting: fetches WOFF2 files at startup (downloaded, or copied
//! from public/) and generates @font-face CSS. HTTP serving is handled by the
//! caller (ServeDir in giojs-server) - this crate owns only fetching and CSS
//! generation.

use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use tracing::info;

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
pub fn font_filename(entry: &FontEntry) -> String {
    format!(
        "{}-{}-{}.woff2",
        sanitize_filename_component(&entry.family),
        entry.weight,
        sanitize_filename_component(&entry.style),
    )
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

/// Fetch every entry's WOFF2 file into `dir`. A `url` with a scheme is
/// downloaded once (an existing file is kept, so only the first start needs
/// the network); any other `url` names a file in `public_dir` and is copied
/// on every start, so an edited file takes effect on restart.
pub async fn download_fonts(
    entries: &[FontEntry],
    dir: &Path,
    public_dir: &Path,
) -> anyhow::Result<()> {
    for entry in entries {
        let path = dir.join(font_filename(entry));
        if !entry.url.contains("://") {
            let source = local_font_path(&entry.url, public_dir)?;
            tokio::fs::copy(&source, &path).await.with_context(|| {
                format!(
                    "font '{}': cannot read {} (url = \"{}\")",
                    entry.family,
                    source.display(),
                    entry.url
                )
            })?;
            continue;
        }
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
    Ok(())
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

/// Generate `@font-face` CSS for all entries.
pub fn generate_css(entries: &[FontEntry]) -> String {
    entries
        .iter()
        .map(|e| {
            // font-style is unquoted in CSS, so it gets the strict [a-z0-9-]
            // filter rather than mere quote escaping.
            format!(
                "@font-face{{font-family:'{}';src:url('/_gio/fonts/{}') format('woff2');font-weight:{};font-style:{};font-display:swap;}}\n",
                escape_css_string(&e.family),
                font_filename(e),
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
        let css = generate_css(&entries);
        assert!(css.contains("@font-face"));
        assert!(css.contains("font-family:'Inter'"));
        assert!(css.contains("inter-400-normal.woff2"));
        assert!(css.contains("font-display:swap"));
        assert!(css.contains("font-weight:400"));
    }

    #[test]
    fn generate_css_empty_returns_empty_string() {
        assert_eq!(generate_css(&[]), "");
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

    #[tokio::test]
    async fn local_fonts_are_copied_on_every_start() {
        let root = std::env::temp_dir().join(format!("gio_font_local_{}", std::process::id()));
        let public = root.join("public");
        let out = root.join("fonts");
        std::fs::create_dir_all(public.join("fonts")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = entry("Inter", 400, "normal");
        e.url = "/fonts/inter.woff2".to_string();

        std::fs::write(public.join("fonts").join("inter.woff2"), b"v1").unwrap();
        download_fonts(std::slice::from_ref(&e), &out, &public)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(out.join("inter-400-normal.woff2")).unwrap(),
            b"v1"
        );

        // An edited file replaces the copy (a downloaded one is kept).
        std::fs::write(public.join("fonts").join("inter.woff2"), b"v2").unwrap();
        download_fonts(std::slice::from_ref(&e), &out, &public)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(out.join("inter-400-normal.woff2")).unwrap(),
            b"v2"
        );

        e.url = "/fonts/missing.woff2".to_string();
        let err = download_fonts(&[e], &out, &public).await.unwrap_err();
        assert!(format!("{err:#}").contains("missing.woff2"), "{err:#}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn generate_css_escapes_quotes_and_backslashes_in_family() {
        let entries = [entry("Ev'il\\Font", 400, "normal';}bad")];
        let css = generate_css(&entries);
        assert!(css.contains("font-family:'Ev\\'il\\\\Font'"));
        assert!(css.contains("font-style:normal---bad;"));
        // Exactly one rule: the payload must not close the declaration early.
        assert_eq!(css.matches('}').count(), 1);
    }
}
