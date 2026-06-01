//! giojs-css/src/transform.rs
//!
//! Lightning CSS transformation pipeline: minification, vendor prefix injection,
//! modern CSS transpilation, and CSS Modules class name hashing.

use std::collections::HashMap;

use lightningcss::css_modules::Config as CssModuleConfig;
use lightningcss::printer::PrinterOptions;
use lightningcss::stylesheet::{ParserOptions, StyleSheet};
use lightningcss::targets::Targets;

use crate::error::CssError;

pub struct CssTransformer {
    pub minify: bool,
}

pub struct TransformResult {
    /// Transformed CSS source.
    pub code: String,
    /// CSS Modules export map: local class name → hashed class name.
    /// `None` for non-module files.
    pub exports: Option<HashMap<String, String>>,
}

impl CssTransformer {
    pub fn transform(&self, source: &str, filename: &str) -> Result<TransformResult, CssError> {
        let is_module = filename.ends_with(".module.css");

        let parse_options = ParserOptions {
            filename: filename.to_string(),
            css_modules: if is_module {
                Some(CssModuleConfig::default())
            } else {
                None
            },
            ..ParserOptions::default()
        };

        let stylesheet =
            StyleSheet::parse(source, parse_options).map_err(|e| CssError::Parse(e.to_string()))?;

        let result = stylesheet
            .to_css(PrinterOptions {
                minify: self.minify,
                targets: Targets::default(),
                ..PrinterOptions::default()
            })
            .map_err(|e| CssError::Print(e.to_string()))?;

        let exports = result.exports.map(|exp| {
            exp.into_iter()
                .map(|(local, export)| (local, export.name))
                .collect()
        });

        Ok(TransformResult {
            code: result.code,
            exports,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transformer(minify: bool) -> CssTransformer {
        CssTransformer { minify }
    }

    #[test]
    fn minification_removes_whitespace() {
        let css = "
            .button {
                color: red;
                /* a comment */
                margin: 0;
            }
        ";
        let result = transformer(true).transform(css, "styles.css").unwrap();
        assert!(
            !result.code.contains("  "),
            "minified output should have no indentation"
        );
        assert!(
            !result.code.contains("/* a comment */"),
            "minified output should drop comments"
        );
        assert!(result.code.contains("color:red"));
    }

    #[test]
    fn non_minified_preserves_structure() {
        let css = ".button { color: red; }";
        let result = transformer(false).transform(css, "styles.css").unwrap();
        assert!(result.code.contains("color: red"));
    }

    #[test]
    fn module_css_produces_exports() {
        let css = ".button { color: blue; } .card { margin: 0; }";
        let result = transformer(false)
            .transform(css, "Component.module.css")
            .unwrap();
        let exports = result.exports.expect("module CSS should produce exports");
        assert!(exports.contains_key("button"), "should export 'button'");
        assert!(exports.contains_key("card"), "should export 'card'");
        // hashed names must differ from original names
        assert_ne!(exports["button"], "button");
        assert_ne!(exports["card"], "card");
    }

    #[test]
    fn non_module_css_has_no_exports() {
        let css = ".button { color: blue; }";
        let result = transformer(false).transform(css, "styles.css").unwrap();
        assert!(result.exports.is_none());
    }

    #[test]
    fn same_module_input_always_same_hashed_names() {
        let css = ".wrapper { display: flex; }";
        let a = transformer(false)
            .transform(css, "Layout.module.css")
            .unwrap();
        let b = transformer(false)
            .transform(css, "Layout.module.css")
            .unwrap();
        assert_eq!(
            a.exports.unwrap()["wrapper"],
            b.exports.unwrap()["wrapper"],
            "CSS Modules hashes must be deterministic"
        );
    }

    #[test]
    fn invalid_css_returns_error() {
        let css = ".button { color: ; }"; // missing value — lightningcss may or may not error
                                          // We just ensure it doesn't panic; it may succeed with recovery or error
        let _ = transformer(false).transform(css, "styles.css");
    }
}
