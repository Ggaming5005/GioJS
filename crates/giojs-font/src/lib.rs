//! giojs-font/src/lib.rs
//!
//! Font self-hosting: downloads WOFF2 files at startup and generates
//! @font-face CSS. HTTP serving is handled by the caller (ServeDir in
//! giojs-server) — this crate owns only download and CSS generation.

use std::path::Path;

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
pub fn font_filename(entry: &FontEntry) -> String {
    format!(
        "{}-{}-{}.woff2",
        entry.family.to_lowercase().replace(' ', "-"),
        entry.weight,
        entry.style,
    )
}

/// Download missing WOFF2 files into `dir`. Skips files that already exist.
pub async fn download_fonts(entries: &[FontEntry], dir: &Path) -> anyhow::Result<()> {
    for entry in entries {
        let path = dir.join(font_filename(entry));
        if path.exists() {
            continue;
        }
        info!(family = %entry.family, weight = %entry.weight, "downloading font");
        let bytes = reqwest::get(&entry.url).await?.bytes().await?;
        tokio::fs::write(&path, bytes).await?;
    }
    Ok(())
}

/// Generate `@font-face` CSS for all entries.
pub fn generate_css(entries: &[FontEntry]) -> String {
    entries
        .iter()
        .map(|e| {
            format!(
                "@font-face{{font-family:'{}';src:url('/_gio/fonts/{}') format('woff2');font-weight:{};font-style:{};font-display:swap;}}\n",
                e.family,
                font_filename(e),
                e.weight,
                e.style,
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
}
