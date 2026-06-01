//! giojs-css/src/critical.rs
//!
//! Critical CSS extraction. Scans rendered HTML for used class names, IDs, and
//! element types, then filters the full CSS to only the rules needed for first
//! paint. Errs on the side of inclusion (false positives are safe; false
//! negatives cause invisible layout).

use std::collections::HashSet;

use lightningcss::stylesheet::{ParserOptions, StyleSheet};

use crate::error::CssError;

pub struct CriticalResult {
    /// CSS rules whose selectors match identifiers found in the HTML.
    pub critical: String,
    /// The original full CSS (returned for use in the async fallback `<link>`).
    pub full_css: String,
}

/// Extract critical CSS from `full_css` based on what identifiers appear in `html`.
///
/// Only runs lightningcss for parse validation. The actual rule filtering uses a
/// brace-depth splitter so we never need to round-trip through the AST for
/// serialization.
pub fn extract_critical(html: &str, full_css: &str) -> Result<CriticalResult, CssError> {
    // Validate CSS syntax upfront.
    StyleSheet::parse(full_css, ParserOptions::default())
        .map_err(|e| CssError::Parse(e.to_string()))?;

    let ids = extract_html_identifiers(html);
    let critical = collect_critical_rules(full_css, &ids);

    Ok(CriticalResult {
        critical,
        full_css: full_css.to_string(),
    })
}

struct HtmlIdentifiers {
    classes: HashSet<String>,
    ids: HashSet<String>,
    elements: HashSet<String>,
}

/// Byte-scan HTML to collect class names, IDs, and element tag names.
/// No DOM parser required — attribute scanning is sufficient.
fn extract_html_identifiers(html: &str) -> HtmlIdentifiers {
    let mut classes = HashSet::new();
    let mut ids = HashSet::new();
    let mut elements = HashSet::new();

    // Always include universal element names so :root, html, body rules are kept.
    elements.insert("html".to_string());
    elements.insert("body".to_string());

    let bytes = html.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Opening tag: extract element name.
        if bytes[i] == b'<' && i + 1 < bytes.len() && bytes[i + 1] != b'/' && bytes[i + 1] != b'!' {
            i += 1;
            let start = i;
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && bytes[i] != b'>'
                && bytes[i] != b'/'
            {
                i += 1;
            }
            if i > start {
                let tag = html[start..i].to_lowercase();
                if !tag.is_empty() && tag.chars().next().is_some_and(|c| c.is_alphabetic()) {
                    elements.insert(tag);
                }
            }
        }

        // class="..." attribute
        if i + 7 < bytes.len() && &bytes[i..i + 7] == b"class=\"" {
            i += 7;
            let start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            if i > start {
                for cls in html[start..i].split_whitespace() {
                    classes.insert(cls.to_string());
                }
            }
        }

        // id="..." attribute
        if i + 4 < bytes.len() && &bytes[i..i + 4] == b"id=\"" {
            i += 4;
            let start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            if i > start {
                ids.insert(html[start..i].to_string());
            }
        }

        i += 1;
    }

    HtmlIdentifiers {
        classes,
        ids,
        elements,
    }
}

/// Walk the CSS string at the top-level rule boundary and collect rules whose
/// selectors match the HTML identifiers. @-rules are always included.
fn collect_critical_rules(css: &str, ids: &HtmlIdentifiers) -> String {
    let mut output = String::new();
    let mut depth: u32 = 0;
    let mut rule_start = 0;
    let mut selector_end: Option<usize> = None;
    let bytes = css.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                if depth == 0 {
                    selector_end = Some(i);
                }
                depth += 1;
            }
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let rule_str = css[rule_start..=i].trim();
                    if !rule_str.is_empty() {
                        if let Some(sel_end) = selector_end {
                            let selector = css[rule_start..sel_end].trim();
                            if rule_is_critical(selector, ids) {
                                output.push_str(rule_str);
                                output.push('\n');
                            }
                        }
                    }
                    rule_start = i + 1;
                    selector_end = None;
                }
            }
            _ => {}
        }
        i += 1;
    }

    output
}

fn rule_is_critical(selector: &str, ids: &HtmlIdentifiers) -> bool {
    let trimmed = selector.trim();

    // @-rules are always included (font-face, keyframes, media, etc.)
    if trimmed.starts_with('@') {
        return true;
    }

    // :root and universal rules always apply
    if trimmed.contains(":root") || trimmed.contains('*') {
        return true;
    }

    // Check each comma-separated selector component
    for part in trimmed.split(',') {
        if selector_part_matches(part.trim(), ids) {
            return true;
        }
    }

    false
}

fn selector_part_matches(part: &str, ids: &HtmlIdentifiers) -> bool {
    // Class name check: .foo anywhere in the selector token sequence
    for class in &ids.classes {
        let dot_class = format!(".{class}");
        if part.contains(&dot_class) {
            return true;
        }
    }

    // ID check: #foo anywhere
    for id in &ids.ids {
        let hash_id = format!("#{id}");
        if part.contains(&hash_id) {
            return true;
        }
    }

    // Element check: selector starts with or equals an element name
    for el in &ids.elements {
        if part == el
            || part.starts_with(&format!("{el}."))
            || part.starts_with(&format!("{el}:"))
            || part.starts_with(&format!("{el} "))
            || part.starts_with(&format!("{el}["))
            || part.starts_with(&format!("{el},"))
        {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_rule_for_used_class() {
        let html = r#"<div class="used">hello</div>"#;
        let css = ".used { color: red; } .unused { color: blue; }";
        let result = extract_critical(html, css).unwrap();
        assert!(
            result.critical.contains("color: red"),
            "used rule should be included"
        );
        assert!(
            !result.critical.contains("color: blue"),
            "unused rule should be excluded"
        );
    }

    #[test]
    fn omits_rule_for_unused_class() {
        let html = r#"<p>no classes here</p>"#;
        let css = ".unused { color: blue; }";
        let result = extract_critical(html, css).unwrap();
        assert!(
            !result.critical.contains("color: blue"),
            "unused class rule should be omitted"
        );
    }

    #[test]
    fn includes_element_selectors() {
        let html = "<h1>Title</h1><p>Text</p>";
        let css = "h1 { margin: 0; } h2 { margin: 0; } p { line-height: 1.6; }";
        let result = extract_critical(html, css).unwrap();
        assert!(result.critical.contains("h1"), "h1 rule should be included");
        assert!(
            !result.critical.contains("h2"),
            "h2 rule should be excluded"
        );
        assert!(result.critical.contains("p"), "p rule should be included");
    }

    #[test]
    fn always_includes_root_selector() {
        let html = "<div>no root selector used explicitly</div>";
        let css = ":root { --bg: #000; } .foo { color: red; }";
        let result = extract_critical(html, css).unwrap();
        assert!(
            result.critical.contains(":root"),
            ":root should always be included"
        );
    }

    #[test]
    fn always_includes_at_rules() {
        let html = "<div>hello</div>";
        let css =
            "@font-face { font-family: 'Inter'; src: url('/inter.woff2'); } .bar { color: red; }";
        let result = extract_critical(html, css).unwrap();
        assert!(
            result.critical.contains("@font-face"),
            "@font-face should always be included"
        );
        assert!(
            !result.critical.contains("color: red"),
            "unmatched .bar should be excluded"
        );
    }

    #[test]
    fn includes_element_with_class_combined_selector() {
        let html = r#"<button class="btn">click</button>"#;
        let css = "button.btn { padding: 8px; } a.btn { padding: 4px; }";
        let result = extract_critical(html, css).unwrap();
        assert!(
            result.critical.contains("button.btn"),
            "button.btn should be included"
        );
    }

    #[test]
    fn returns_full_css_unchanged() {
        let html = "<div>test</div>";
        let css = ".foo { color: red; }";
        let result = extract_critical(html, css).unwrap();
        assert_eq!(result.full_css, css);
    }

    #[test]
    fn does_not_panic_on_malformed_css() {
        // lightningcss uses error recovery — malformed input does not necessarily
        // return an error, but must never panic.
        let html = "<div>test</div>";
        let css = ".broken { color: "; // unclosed declaration
        let _ = extract_critical(html, css); // must not panic
    }
}
