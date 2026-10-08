//! giojs-i18n/src/lib.rs
//!
//! Locale detection and path normalization. Three strategies: path prefix,
//! Accept-Language header, gio_locale cookie. Evaluated in config-defined order.
//! Lock-free; beyond the returned LocaleResult, only the Accept-Language
//! strategy allocates (the header's ranges, to order them by q-value).

use std::collections::HashMap;

pub struct I18nConfig {
    pub locales: Vec<String>,
    pub default_locale: String,
    /// Strategy order: "path", "accept-language", "cookie"
    pub detect_from: Vec<String>,
}

pub struct LocaleResult {
    pub locale: String,
    /// De-localized path - locale prefix stripped if path detection matched.
    pub path: String,
    /// Whether request headers took part in the decision: a header strategy
    /// (cookie or Accept-Language) was tried before one decided, so other
    /// header values could have picked another locale for the same URL.
    /// False only when the URL alone decides (its locale prefix, checked
    /// ahead of every header strategy) or no header strategy is configured.
    pub header_dependent: bool,
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
            header_dependent: false,
        };
    }

    // Always extract path locale - stripping is structural even if "path" strategy is disabled.
    let (path_locale, delocalized_path) = extract_path_locale(path, &config.locales);

    let mut header_dependent = false;
    for strategy in &config.detect_from {
        let detected = match strategy.as_str() {
            "path" => path_locale.clone(),
            "cookie" => {
                header_dependent = true;
                detect_from_cookie(headers, &config.locales)
            }
            "accept-language" => {
                header_dependent = true;
                detect_from_accept_language(headers, &config.locales)
            }
            _ => None,
        };
        if let Some(locale) = detected {
            return LocaleResult {
                locale,
                path: delocalized_path,
                header_dependent,
            };
        }
    }

    LocaleResult {
        locale: config.default_locale.clone(),
        path: delocalized_path,
        header_dependent,
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

/// The configured locale the Accept-Language header asks for first. Ranges
/// are tried by q-value, highest first (written order breaks ties), and a
/// `q=0` range ("not this one") or one with a malformed q is never chosen.
/// A range matches a locale case-insensitively, either as a whole (`pt-BR`)
/// or by its language subtag (`de-AT` picks `de`). The result is always the
/// configured spelling: the locale is compared against path segments and
/// cookie values exactly, and keys the page cache.
fn detect_from_accept_language(
    headers: &HashMap<String, String>,
    locales: &[String],
) -> Option<String> {
    let header = headers.get("accept-language")?;
    let mut ranges: Vec<(&str, u16)> = header.split(',').filter_map(parse_language_range).collect();
    // Stable: equal q-values keep the order the client wrote them in.
    ranges.sort_by_key(|&(_, q)| std::cmp::Reverse(q));
    for (tag, _) in ranges {
        if let Some(locale) = locales.iter().find(|l| l.eq_ignore_ascii_case(tag)) {
            return Some(locale.clone());
        }
        let lang = tag.split('-').next().unwrap_or(tag);
        if let Some(locale) = locales.iter().find(|l| l.eq_ignore_ascii_case(lang)) {
            return Some(locale.clone());
        }
    }
    None
}

/// One `language-range [;q=qvalue]` entry as (range, q in thousandths).
/// None for an empty range, `q=0`, or a q that is not a valid qvalue
/// (0 to 1, at most three decimals).
fn parse_language_range(entry: &str) -> Option<(&str, u16)> {
    let mut parts = entry.split(';');
    let tag = parts.next()?.trim();
    if tag.is_empty() {
        return None;
    }
    let mut q = 1000;
    for param in parts {
        let Some((name, value)) = param.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("q") {
            q = parse_qvalue(value.trim())?;
        }
    }
    (q > 0).then_some((tag, q))
}

/// RFC 9110 qvalue: `0[.ddd]` or `1[.000]`, as thousandths.
fn parse_qvalue(value: &str) -> Option<u16> {
    let (int, frac) = value.split_once('.').unwrap_or((value, ""));
    if frac.len() > 3 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Right-pad to three digits: ".5" is 500 thousandths.
    let frac_thousandths = frac
        .bytes()
        .chain(std::iter::repeat(b'0'))
        .take(3)
        .fold(0u16, |acc, digit| acc * 10 + u16::from(digit - b'0'));
    match int {
        "0" => Some(frac_thousandths),
        "1" if frac_thousandths == 0 => Some(1000),
        _ => None,
    }
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

    fn accept_language(value: &str) -> HashMap<String, String> {
        HashMap::from([("accept-language".to_string(), value.to_string())])
    }

    #[test]
    fn accept_language_returns_the_configured_spelling() {
        let cfg = config(&["en", "pt-BR"]);
        for header in ["pt-BR", "pt-br", "PT-BR;q=0.9"] {
            let r = detect_locale("/about", &accept_language(header), &cfg);
            assert_eq!(r.locale, "pt-BR", "{header}");
        }
        // The language-only fallback already did.
        let r = detect_locale("/about", &accept_language("EN-gb"), &cfg);
        assert_eq!(r.locale, "en");
    }

    #[test]
    fn accept_language_orders_ranges_by_q_value() {
        let cfg = config(&["en", "fr", "de"]);
        let detect = |header: &str| detect_locale("/about", &accept_language(header), &cfg).locale;
        assert_eq!(detect("en;q=0.1, fr"), "fr");
        assert_eq!(detect("de;q=0.1, en;q=0.9"), "en");
        assert_eq!(detect("de-AT;q=0.5, fr;q=0.8, en;q=0.7"), "fr");
        // Equal q-values keep the written order.
        assert_eq!(detect("fr;q=0.5, de;q=0.5"), "fr");
        assert_eq!(detect("de, fr"), "de");
        // Unsupported ranges are skipped, whatever their q.
        assert_eq!(detect("ja, es;q=0.9, de;q=0.2"), "de");
    }

    #[test]
    fn accept_language_never_picks_a_refused_or_malformed_range() {
        let cfg = config(&["en", "fr", "de"]);
        let detect = |header: &str| detect_locale("/about", &accept_language(header), &cfg).locale;
        // q=0 means "not acceptable": the default locale, not fr.
        assert_eq!(detect("fr;q=0"), "en");
        assert_eq!(detect("fr;q=0.000, de;q=0.001"), "de");
        assert_eq!(detect("fr;Q=0, de"), "de");
        for malformed in [
            "fr;q=2",
            "fr;q=1.5",
            "fr;q=0.1234",
            "fr;q=abc",
            "fr;q=",
            "fr;q=-1",
        ] {
            assert_eq!(detect(malformed), "en", "{malformed}");
        }
        assert_eq!(detect("fr;q=1.000"), "fr");
        assert_eq!(detect("*, fr;q=0.5"), "fr");
        assert_eq!(detect(" , ;q=1"), "en");
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

    fn ordered(detect_from: &[&str]) -> I18nConfig {
        I18nConfig {
            detect_from: detect_from.iter().map(|s| s.to_string()).collect(),
            ..config(&["en", "de"])
        }
    }

    #[test]
    fn header_dependence_follows_the_strategy_order() {
        let german = accept_language("de");
        // Path first: a prefixed URL is decided by the URL alone.
        let path_first = ordered(&["path", "accept-language"]);
        let r = detect_locale("/de/about", &german, &path_first);
        assert_eq!((r.locale.as_str(), r.header_dependent), ("de", false));
        // An unprefixed URL fell through to the header.
        let r = detect_locale("/about", &no_headers(), &path_first);
        assert_eq!((r.locale.as_str(), r.header_dependent), ("en", true));

        // A header ahead of the path: the prefixed URL varies by header,
        // even when the header is absent and the path ends up deciding.
        let header_first = ordered(&["accept-language", "path"]);
        let r = detect_locale("/de/about", &accept_language("en"), &header_first);
        assert_eq!((r.locale.as_str(), r.path.as_str()), ("en", "/about"));
        assert!(r.header_dependent);
        let r = detect_locale("/de/about", &no_headers(), &header_first);
        assert_eq!((r.locale.as_str(), r.header_dependent), ("de", true));
        let r = detect_locale("/de/about", &no_headers(), &ordered(&["cookie", "path"]));
        assert!(r.header_dependent);

        // No path strategy: the prefix is stripped but never decides.
        let r = detect_locale("/de/about", &german, &ordered(&["accept-language"]));
        assert_eq!((r.path.as_str(), r.header_dependent), ("/about", true));
        // No header strategy: nothing depends on headers.
        let r = detect_locale("/about", &german, &ordered(&["path"]));
        assert_eq!((r.locale.as_str(), r.header_dependent), ("en", false));
    }
}
