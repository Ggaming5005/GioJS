//! giojs-font/src/lib.rs
//!
//! Font self-hosting: downloads WOFF2 files at startup and generates
//! @font-face CSS. HTTP serving is handled by the caller (ServeDir in
//! giojs-server) - this crate owns only download and CSS generation.

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
    fn generate_css_escapes_quotes_and_backslashes_in_family() {
        let entries = [entry("Ev'il\\Font", 400, "normal';}bad")];
        let css = generate_css(&entries);
        assert!(css.contains("font-family:'Ev\\'il\\\\Font'"));
        assert!(css.contains("font-style:normal---bad;"));
        // Exactly one rule: the payload must not close the declaration early.
        assert_eq!(css.matches('}').count(), 1);
    }
}
