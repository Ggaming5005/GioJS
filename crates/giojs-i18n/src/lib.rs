//! giojs-i18n/src/lib.rs
//!
//! Locale detection and path normalization. Three strategies: path prefix,
//! Accept-Language header, gio_locale cookie. Evaluated in config-defined order.
//! Lock-free, no allocation on the hot path beyond the returned LocaleResult.

use std::collections::HashMap;

pub struct I18nConfig {
    pub locales: Vec<String>,
    pub default_locale: String,
    /// Strategy order: "path", "accept-language", "cookie"
    pub detect_from: Vec<String>,
}

pub struct LocaleResult {
    pub locale: String,
    /// De-localized path — locale prefix stripped if path detection matched.
    pub path: String,
}

pub fn detect_locale(
    path: &str,
    headers: &HashMap<String, String>,
    config: &I18nConfig,
) -> LocaleResult {
    if config.locales.is_empty() {
        return LocaleResult {
            locale: config.default_locale.clone(),
            path: path.to_string(),
        };
    }

    // Always extract path locale — stripping is structural even if "path" strategy is disabled.
    let (path_locale, delocalized_path) = extract_path_locale(path, &config.locales);

    for strategy in &config.detect_from {
        match strategy.as_str() {
            "path" => {
                if let Some(ref locale) = path_locale {
                    return LocaleResult {
                        locale: locale.clone(),
                        path: delocalized_path.clone(),
                    };
                }
            }
            "cookie" => {
                if let Some(locale) = detect_from_cookie(headers, &config.locales) {
                    return LocaleResult {
                        locale,
                        path: delocalized_path.clone(),
                    };
                }
            }
            "accept-language" => {
                if let Some(locale) = detect_from_accept_language(headers, &config.locales) {
                    return LocaleResult {
                        locale,
                        path: delocalized_path.clone(),
                    };
                }
            }
            _ => {}
        }
    }

    LocaleResult {
        locale: config.default_locale.clone(),
        path: delocalized_path,
    }
}

fn extract_path_locale(path: &str, locales: &[String]) -> (Option<String>, String) {
    let stripped = path.trim_start_matches('/');
    let (segment, rest) = match stripped.find('/') {
        Some(pos) => (&stripped[..pos], &stripped[pos..]),
        None => (stripped, ""),
    };
    if locales.iter().any(|l| l == segment) {
        let delocalized = if rest.is_empty() {
            "/".to_string()
        } else {
            rest.to_string()
        };
        return (Some(segment.to_string()), delocalized);
    }
    (None, path.to_string())
}

fn detect_from_cookie(headers: &HashMap<String, String>, locales: &[String]) -> Option<String> {
    let cookie_header = headers.get("cookie")?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("gio_locale=") {
            let value = value.trim();
            if locales.iter().any(|l| l == value) {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn detect_from_accept_language(
    headers: &HashMap<String, String>,
    locales: &[String],
) -> Option<String> {
    let header = headers.get("accept-language")?;
    for entry in header.split(',') {
        let tag = entry.split(';').next()?.trim();
        if locales.iter().any(|l| l.eq_ignore_ascii_case(tag)) {
            return Some(tag.to_ascii_lowercase());
        }
        let lang = tag.split('-').next()?;
        if let Some(locale) = locales.iter().find(|l| l.eq_ignore_ascii_case(lang)) {
            return Some(locale.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(locales: &[&str]) -> I18nConfig {
        I18nConfig {
            locales: locales.iter().map(|s| s.to_string()).collect(),
            default_locale: "en".to_string(),
            detect_from: vec![
                "path".to_string(),
                "cookie".to_string(),
                "accept-language".to_string(),
            ],
        }
    }

    fn no_headers() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn path_locale_detected_and_stripped() {
        let r = detect_locale("/fr/about", &no_headers(), &config(&["en", "fr", "de"]));
        assert_eq!(r.locale, "fr");
        assert_eq!(r.path, "/about");
    }

    #[test]
    fn unknown_prefix_kept_in_path() {
        let r = detect_locale("/xyz/about", &no_headers(), &config(&["en", "fr"]));
        assert_eq!(r.locale, "en");
        assert_eq!(r.path, "/xyz/about");
    }

    #[test]
    fn accept_language_fallback() {
        let mut h = HashMap::new();
        h.insert(
            "accept-language".to_string(),
            "de-AT,de;q=0.9,en;q=0.8".to_string(),
        );
        let r = detect_locale("/about", &h, &config(&["en", "fr", "de"]));
        assert_eq!(r.locale, "de");
        assert_eq!(r.path, "/about");
    }

    #[test]
    fn cookie_wins_over_accept_language() {
        let mut h = HashMap::new();
        h.insert("accept-language".to_string(), "fr".to_string());
        h.insert("cookie".to_string(), "gio_locale=de; other=x".to_string());
        let r = detect_locale("/about", &h, &config(&["en", "fr", "de"]));
        // cookie strategy is listed before accept-language in test config
        assert_eq!(r.locale, "de");
    }

    #[test]
    fn default_locale_when_no_signals() {
        let r = detect_locale("/about", &no_headers(), &config(&["en", "fr"]));
        assert_eq!(r.locale, "en");
        assert_eq!(r.path, "/about");
    }

    #[test]
    fn root_locale_path_normalizes_to_slash() {
        let r = detect_locale("/fr", &no_headers(), &config(&["en", "fr"]));
        assert_eq!(r.locale, "fr");
        assert_eq!(r.path, "/");
    }

    #[test]
    fn empty_locales_config_is_passthrough() {
        let cfg = I18nConfig {
            locales: vec![],
            default_locale: "en".to_string(),
            detect_from: vec!["path".to_string()],
        };
        let r = detect_locale("/fr/about", &no_headers(), &cfg);
        assert_eq!(r.locale, "en");
        assert_eq!(r.path, "/fr/about");
    }
}
