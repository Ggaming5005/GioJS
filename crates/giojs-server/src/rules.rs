//! giojs-server/src/rules.rs
//!
//! Declarative middleware rules (redirects, rewrites, response headers, auth
//! guards) executed in the Rust HTTP layer before routing and before any Node
//! code. Rules come from gio.toml (static) and from the worker's READY frame
//! (middleware.ts). Patterns share the routing conventions: literal segments,
//! `:param` captures, `*rest` catch-all. Evaluation order per request:
//! guards, then redirects, then rewrites - first match wins within each phase,
//! and when two rule sets are merged the static (gio.toml) set is checked
//! before the worker set inside every phase. Header rules stamp responses
//! independently of the short-circuiting phases. All header names/values and
//! redirect statuses are validated once at compile/load time (invalid entries
//! are skipped with a warning), never at request time.

use axum::http::{HeaderName, HeaderValue, StatusCode};
use serde::Deserialize;
use thiserror::Error;
use tracing::warn;

#[derive(Debug, Error)]
pub enum RuleError {
    #[error("pattern must start with '/': {0}")]
    PatternNotAbsolute(String),
    #[error("catch-all segment must be the last segment: {0}")]
    CatchAllNotLast(String),
    #[error("target references unknown capture '{0}'")]
    UnknownCapture(String),
    #[error("redirect status must be 301, 302, 307, or 308 (got {0})")]
    InvalidRedirectStatus(u16),
    #[error("invalid header name: {0}")]
    InvalidHeaderName(String),
    #[error("invalid header value for '{0}'")]
    InvalidHeaderValue(String),
    #[error("empty required field: {0}")]
    EmptyField(&'static str),
}

/// `[[redirects]]` in gio.toml / `redirects` in middleware.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct RedirectRule {
    pub from: String,
    pub to: String,
    #[serde(default = "default_redirect_status")]
    pub status: u16,
}

fn default_redirect_status() -> u16 {
    302
}

/// `[[rewrites]]` in gio.toml / `rewrites` in middleware.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct RewriteRule {
    pub from: String,
    pub to: String,
}

/// `[[headers]]` in gio.toml: `path = "/x"` plus a `[headers.headers]` table
/// mapping header names to values. middleware.ts sends the same shape as a
/// JSON object (`headers: { "x-frame-options": "DENY" }`).
#[derive(Debug, Clone, Deserialize)]
pub struct HeaderRule {
    pub path: String,
    pub headers: std::collections::HashMap<String, String>,
}

/// `[[guards]]` in gio.toml (snake_case) / `guards` in middleware.ts
/// (camelCase aliases). A request to a matching path without a non-empty
/// cookie of the given name is redirected (302) and never reaches Node.
#[derive(Debug, Clone, Deserialize)]
pub struct GuardRule {
    pub path: String,
    #[serde(alias = "requireCookie")]
    pub require_cookie: String,
    #[serde(alias = "redirectTo")]
    pub redirect_to: String,
}

/// The raw, wire/config-shaped bundle of all rule kinds. Deserializes from
/// both gio.toml sections and the READY frame's `middleware` field.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MiddlewareRules {
    #[serde(default)]
    pub redirects: Vec<RedirectRule>,
    #[serde(default)]
    pub rewrites: Vec<RewriteRule>,
    #[serde(default)]
    pub headers: Vec<HeaderRule>,
    #[serde(default)]
    pub guards: Vec<GuardRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(String),
    Param,
    CatchAll,
}

/// Compiled path pattern. Matching walks `path.split('/')` without allocating
/// for literals; captures borrow from the request path.
#[derive(Debug, Clone)]
struct Pattern {
    segments: Vec<Segment>,
    /// Capture names in order (`:param`s, then the `*rest` name if present).
    capture_names: Vec<String>,
}

impl Pattern {
    fn compile(raw: &str) -> Result<Self, RuleError> {
        if !raw.starts_with('/') {
            return Err(RuleError::PatternNotAbsolute(raw.to_string()));
        }
        let mut segments = Vec::new();
        let mut capture_names = Vec::new();
        let raw_segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
        for (index, raw_segment) in raw_segments.iter().enumerate() {
            if let Some(name) = raw_segment.strip_prefix(':') {
                capture_names.push(name.to_string());
                segments.push(Segment::Param);
            } else if let Some(name) = raw_segment.strip_prefix('*') {
                if index != raw_segments.len() - 1 {
                    return Err(RuleError::CatchAllNotLast(raw.to_string()));
                }
                capture_names.push(name.to_string());
                segments.push(Segment::CatchAll);
            } else {
                segments.push(Segment::Literal((*raw_segment).to_string()));
            }
        }
        Ok(Pattern {
            segments,
            capture_names,
        })
    }

    /// Match `path`, returning captured values in `capture_names` order.
    /// A `*rest` capture takes the entire remainder (slashes included) and
    /// requires at least one segment. `None` allocates nothing for patterns
    /// without captures.
    fn match_path<'p>(&self, path: &'p str) -> Option<Vec<&'p str>> {
        let mut captures: Vec<&'p str> = Vec::new();
        let mut rest = path.trim_start_matches('/');
        for segment in &self.segments {
            if *segment == Segment::CatchAll {
                let remainder = rest.trim_end_matches('/');
                if remainder.is_empty() {
                    return None;
                }
                captures.push(remainder);
                return Some(captures);
            }
            let (head, tail) = match rest.find('/') {
                Some(pos) => (&rest[..pos], rest[pos + 1..].trim_start_matches('/')),
                None => (rest, ""),
            };
            if head.is_empty() {
                return None;
            }
            match segment {
                Segment::Literal(literal) => {
                    if literal != head {
                        return None;
                    }
                }
                Segment::Param => captures.push(head),
                Segment::CatchAll => return None,
            }
            rest = tail;
        }
        if rest.trim_matches('/').is_empty() {
            Some(captures)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
enum TemplatePart {
    Literal(String),
    Capture(usize),
}

/// Compiled `to` target. `:param` / `*rest` parts reference captures by
/// index, resolved once at compile time against the source pattern.
#[derive(Debug, Clone)]
struct Template {
    parts: Vec<TemplatePart>,
}

impl Template {
    fn compile(raw: &str, pattern: &Pattern) -> Result<Self, RuleError> {
        if !raw.starts_with('/') {
            return Err(RuleError::PatternNotAbsolute(raw.to_string()));
        }
        let mut parts = Vec::new();
        for raw_segment in raw.split('/').filter(|s| !s.is_empty()) {
            let capture_name = raw_segment
                .strip_prefix(':')
                .or_else(|| raw_segment.strip_prefix('*'));
            match capture_name {
                Some(name) => {
                    let index = pattern
                        .capture_names
                        .iter()
                        .position(|candidate| candidate == name)
                        .ok_or_else(|| RuleError::UnknownCapture(name.to_string()))?;
                    parts.push(TemplatePart::Capture(index));
                }
                None => parts.push(TemplatePart::Literal(raw_segment.to_string())),
            }
        }
        Ok(Template { parts })
    }

    fn expand(&self, captures: &[&str]) -> String {
        let mut target = String::new();
        for part in &self.parts {
            target.push('/');
            match part {
                TemplatePart::Literal(literal) => target.push_str(literal),
                TemplatePart::Capture(index) => {
                    target.push_str(captures.get(*index).copied().unwrap_or(""));
                }
            }
        }
        if target.is_empty() {
            target.push('/');
        }
        target
    }
}

#[derive(Debug)]
struct CompiledRedirect {
    pattern: Pattern,
    to: Template,
    status: StatusCode,
}

impl CompiledRedirect {
    fn compile(rule: &RedirectRule) -> Result<Self, RuleError> {
        let status = match rule.status {
            301 | 302 | 307 | 308 => StatusCode::from_u16(rule.status)
                .map_err(|_| RuleError::InvalidRedirectStatus(rule.status))?,
            other => return Err(RuleError::InvalidRedirectStatus(other)),
        };
        let pattern = Pattern::compile(&rule.from)?;
        let to = Template::compile(&rule.to, &pattern)?;
        Ok(CompiledRedirect {
            pattern,
            to,
            status,
        })
    }
}

#[derive(Debug)]
struct CompiledRewrite {
    pattern: Pattern,
    to: Template,
}

impl CompiledRewrite {
    fn compile(rule: &RewriteRule) -> Result<Self, RuleError> {
        let pattern = Pattern::compile(&rule.from)?;
        let to = Template::compile(&rule.to, &pattern)?;
        Ok(CompiledRewrite { pattern, to })
    }
}

#[derive(Debug)]
struct CompiledGuard {
    pattern: Pattern,
    require_cookie: String,
    redirect_to: String,
}

impl CompiledGuard {
    fn compile(rule: &GuardRule) -> Result<Self, RuleError> {
        if rule.require_cookie.is_empty() {
            return Err(RuleError::EmptyField("require_cookie"));
        }
        if !rule.redirect_to.starts_with('/') {
            return Err(RuleError::PatternNotAbsolute(rule.redirect_to.clone()));
        }
        Ok(CompiledGuard {
            pattern: Pattern::compile(&rule.path)?,
            require_cookie: rule.require_cookie.clone(),
            redirect_to: rule.redirect_to.clone(),
        })
    }
}

#[derive(Debug)]
struct CompiledHeaderRule {
    pattern: Pattern,
    headers: Vec<(HeaderName, HeaderValue)>,
}

impl CompiledHeaderRule {
    fn compile(rule: &HeaderRule) -> Result<Self, RuleError> {
        let mut headers = Vec::with_capacity(rule.headers.len());
        for (name, value) in &rule.headers {
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| RuleError::InvalidHeaderName(name.clone()))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|_| RuleError::InvalidHeaderValue(name.clone()))?;
            headers.push((header_name, header_value));
        }
        Ok(CompiledHeaderRule {
            pattern: Pattern::compile(&rule.path)?,
            headers,
        })
    }
}

/// Result of running the short-circuiting phases against one request path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleOutcome {
    None,
    Redirect {
        location: String,
        status: StatusCode,
    },
    Rewrite {
        new_path: String,
    },
}

/// A compiled, request-ready set of rules. `apply` runs the short-circuiting
/// phases (guards, redirects, rewrites); `response_headers` is stamped on the
/// response separately by the caller.
#[derive(Debug, Default)]
pub struct RuleSet {
    guards: Vec<CompiledGuard>,
    redirects: Vec<CompiledRedirect>,
    rewrites: Vec<CompiledRewrite>,
    headers: Vec<CompiledHeaderRule>,
}

impl RuleSet {
    /// Compile raw rules, skipping (with a warning) any entry that fails
    /// validation. This is the load-time gate: nothing after this point can
    /// fail or panic at request time.
    pub fn compile(raw: &MiddlewareRules) -> Self {
        let mut compiled = RuleSet::default();
        for rule in &raw.guards {
            match CompiledGuard::compile(rule) {
                Ok(guard) => compiled.guards.push(guard),
                Err(e) => warn!(path = %rule.path, error = %e, "invalid guard rule skipped"),
            }
        }
        for rule in &raw.redirects {
            match CompiledRedirect::compile(rule) {
                Ok(redirect) => compiled.redirects.push(redirect),
                Err(e) => warn!(from = %rule.from, error = %e, "invalid redirect rule skipped"),
            }
        }
        for rule in &raw.rewrites {
            match CompiledRewrite::compile(rule) {
                Ok(rewrite) => compiled.rewrites.push(rewrite),
                Err(e) => warn!(from = %rule.from, error = %e, "invalid rewrite rule skipped"),
            }
        }
        for rule in &raw.headers {
            match CompiledHeaderRule::compile(rule) {
                Ok(header_rule) => compiled.headers.push(header_rule),
                Err(e) => warn!(path = %rule.path, error = %e, "invalid header rule skipped"),
            }
        }
        compiled
    }

    pub fn is_empty(&self) -> bool {
        self.guards.is_empty()
            && self.redirects.is_empty()
            && self.rewrites.is_empty()
            && self.headers.is_empty()
    }

    pub fn has_header_rules(&self) -> bool {
        !self.headers.is_empty()
    }

    pub fn apply(&self, path: &str, cookie_header: Option<&str>) -> RuleOutcome {
        if let Some(outcome) = self.check_guards(path, cookie_header) {
            return outcome;
        }
        if let Some(outcome) = self.check_redirects(path) {
            return outcome;
        }
        if let Some(outcome) = self.check_rewrites(path) {
            return outcome;
        }
        RuleOutcome::None
    }

    fn check_guards(&self, path: &str, cookie_header: Option<&str>) -> Option<RuleOutcome> {
        for guard in &self.guards {
            if guard.pattern.match_path(path).is_none() {
                continue;
            }
            let authorized = cookie_header
                .map(|cookies| cookie_has_value(cookies, &guard.require_cookie))
                .unwrap_or(false);
            if !authorized {
                return Some(RuleOutcome::Redirect {
                    location: guard.redirect_to.clone(),
                    status: StatusCode::FOUND,
                });
            }
        }
        None
    }

    fn check_redirects(&self, path: &str) -> Option<RuleOutcome> {
        for redirect in &self.redirects {
            if let Some(captures) = redirect.pattern.match_path(path) {
                return Some(RuleOutcome::Redirect {
                    location: redirect.to.expand(&captures),
                    status: redirect.status,
                });
            }
        }
        None
    }

    fn check_rewrites(&self, path: &str) -> Option<RuleOutcome> {
        for rewrite in &self.rewrites {
            if let Some(captures) = rewrite.pattern.match_path(path) {
                return Some(RuleOutcome::Rewrite {
                    new_path: rewrite.to.expand(&captures),
                });
            }
        }
        None
    }

    /// Headers from every matching header rule, pre-validated at compile time.
    /// Cloning `HeaderName`/`HeaderValue` is cheap (Bytes-backed refcounts).
    pub fn response_headers(&self, path: &str) -> Vec<(HeaderName, HeaderValue)> {
        let mut collected = Vec::new();
        for rule in &self.headers {
            if rule.pattern.match_path(path).is_some() {
                collected.extend(rule.headers.iter().cloned());
            }
        }
        collected
    }
}

/// Merged evaluation across the static (gio.toml) and worker (middleware.ts)
/// sets: within each phase the static set is checked first, and the phase
/// order (guards, redirects, rewrites) holds across both sets.
pub fn apply_merged(
    static_rules: &RuleSet,
    worker_rules: &RuleSet,
    path: &str,
    cookie_header: Option<&str>,
) -> RuleOutcome {
    for rules in [static_rules, worker_rules] {
        if let Some(outcome) = rules.check_guards(path, cookie_header) {
            return outcome;
        }
    }
    for rules in [static_rules, worker_rules] {
        if let Some(outcome) = rules.check_redirects(path) {
            return outcome;
        }
    }
    for rules in [static_rules, worker_rules] {
        if let Some(outcome) = rules.check_rewrites(path) {
            return outcome;
        }
    }
    RuleOutcome::None
}

/// Append the original query string verbatim to a redirect/rewrite target.
pub fn with_query(target: String, query: Option<&str>) -> String {
    match query {
        Some(query) if !query.is_empty() => format!("{target}?{query}"),
        _ => target,
    }
}

/// True when the Cookie header contains `name` with a non-empty value.
/// Parses the `k=v; k2=v2` wire format without allocating.
fn cookie_has_value(cookie_header: &str, name: &str) -> bool {
    cookie_header
        .split(';')
        .any(|pair| match pair.trim().split_once('=') {
            Some((key, value)) => key.trim() == name && !value.trim().is_empty(),
            None => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redirect(from: &str, to: &str, status: u16) -> RedirectRule {
        RedirectRule {
            from: from.to_string(),
            to: to.to_string(),
            status,
        }
    }

    fn rules_with_redirect(from: &str, to: &str, status: u16) -> RuleSet {
        RuleSet::compile(&MiddlewareRules {
            redirects: vec![redirect(from, to, status)],
            ..Default::default()
        })
    }

    fn rules_with_rewrite(from: &str, to: &str) -> RuleSet {
        RuleSet::compile(&MiddlewareRules {
            rewrites: vec![RewriteRule {
                from: from.to_string(),
                to: to.to_string(),
            }],
            ..Default::default()
        })
    }

    fn guard(path: &str, cookie: &str, redirect_to: &str) -> GuardRule {
        GuardRule {
            path: path.to_string(),
            require_cookie: cookie.to_string(),
            redirect_to: redirect_to.to_string(),
        }
    }

    // ── pattern matching ─────────────────────────────────────────────────────

    #[test]
    fn literal_pattern_matches_exact_path_only() {
        let rules = rules_with_redirect("/old-home", "/", 302);
        assert_eq!(
            rules.apply("/old-home", None),
            RuleOutcome::Redirect {
                location: "/".to_string(),
                status: StatusCode::FOUND
            }
        );
        assert_eq!(rules.apply("/old-home/extra", None), RuleOutcome::None);
        assert_eq!(rules.apply("/old", None), RuleOutcome::None);
        assert_eq!(rules.apply("/old-homely", None), RuleOutcome::None);
    }

    #[test]
    fn trailing_slash_on_request_path_still_matches() {
        let rules = rules_with_redirect("/old-home", "/", 302);
        assert!(matches!(
            rules.apply("/old-home/", None),
            RuleOutcome::Redirect { .. }
        ));
    }

    #[test]
    fn root_pattern_matches_only_root() {
        let rules = rules_with_redirect("/", "/home", 302);
        assert!(matches!(
            rules.apply("/", None),
            RuleOutcome::Redirect { .. }
        ));
        assert_eq!(rules.apply("/anything", None), RuleOutcome::None);
    }

    #[test]
    fn param_capture_substitutes_into_target() {
        let rules = rules_with_redirect("/blog/:slug", "/posts/:slug", 302);
        assert_eq!(
            rules.apply("/blog/hello-world", None),
            RuleOutcome::Redirect {
                location: "/posts/hello-world".to_string(),
                status: StatusCode::FOUND
            }
        );
        assert_eq!(rules.apply("/blog", None), RuleOutcome::None);
        assert_eq!(rules.apply("/blog/a/b", None), RuleOutcome::None);
    }

    #[test]
    fn multiple_params_substitute_in_any_target_order() {
        let rules = rules_with_redirect("/u/:user/p/:post", "/p/:post/by/:user", 302);
        assert_eq!(
            rules.apply("/u/alice/p/42", None),
            RuleOutcome::Redirect {
                location: "/p/42/by/alice".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn catch_all_captures_the_full_remainder() {
        let rules = rules_with_rewrite("/docs/*rest", "/guide/*rest");
        assert_eq!(
            rules.apply("/docs/a/b/c", None),
            RuleOutcome::Rewrite {
                new_path: "/guide/a/b/c".to_string()
            }
        );
    }

    #[test]
    fn catch_all_requires_at_least_one_segment() {
        let rules = rules_with_rewrite("/docs/*rest", "/guide/*rest");
        assert_eq!(rules.apply("/docs", None), RuleOutcome::None);
        assert_eq!(rules.apply("/docs/", None), RuleOutcome::None);
    }

    #[test]
    fn catch_all_in_the_middle_is_rejected_at_load() {
        let rules = rules_with_rewrite("/a/*rest/b", "/x");
        assert!(rules.is_empty());
    }

    #[test]
    fn relative_pattern_is_rejected_at_load() {
        let rules = rules_with_redirect("old-home", "/", 302);
        assert!(rules.is_empty());
    }

    // ── redirect statuses ────────────────────────────────────────────────────

    #[test]
    fn default_redirect_status_is_302() {
        assert_eq!(default_redirect_status(), 302);
        let parsed: RedirectRule =
            serde_json::from_str(r#"{"from":"/a","to":"/b"}"#).expect("valid rule json");
        assert_eq!(parsed.status, 302);
    }

    #[test]
    fn all_allowed_redirect_statuses_compile() {
        for status in [301u16, 302, 307, 308] {
            let rules = rules_with_redirect("/a", "/b", status);
            assert!(matches!(
                rules.apply("/a", None),
                RuleOutcome::Redirect { status: s, .. } if s.as_u16() == status
            ));
        }
    }

    #[test]
    fn disallowed_redirect_status_is_rejected_at_load() {
        let rules = rules_with_redirect("/a", "/b", 200);
        assert!(rules.is_empty());
        assert_eq!(rules.apply("/a", None), RuleOutcome::None);
    }

    #[test]
    fn unknown_capture_in_target_is_rejected_at_load() {
        let rules = rules_with_redirect("/blog/:slug", "/posts/:id", 302);
        assert!(rules.is_empty());
    }

    // ── guards ───────────────────────────────────────────────────────────────

    #[test]
    fn guard_redirects_when_cookie_is_absent() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin", "session", "/login")],
            ..Default::default()
        });
        assert_eq!(
            rules.apply("/admin", None),
            RuleOutcome::Redirect {
                location: "/login".to_string(),
                status: StatusCode::FOUND
            }
        );
        assert_eq!(
            rules.apply("/admin", Some("other=1")),
            RuleOutcome::Redirect {
                location: "/login".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn guard_passes_when_named_cookie_has_a_value() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin", "session", "/login")],
            ..Default::default()
        });
        assert_eq!(
            rules.apply("/admin", Some("a=1; session=x")),
            RuleOutcome::None
        );
        assert_eq!(rules.apply("/admin", Some("session=x")), RuleOutcome::None);
    }

    #[test]
    fn guard_treats_empty_cookie_value_as_absent() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin", "session", "/login")],
            ..Default::default()
        });
        assert!(matches!(
            rules.apply("/admin", Some("session=")),
            RuleOutcome::Redirect { .. }
        ));
        assert!(matches!(
            rules.apply("/admin", Some("session= ; a=1")),
            RuleOutcome::Redirect { .. }
        ));
    }

    #[test]
    fn guard_cookie_name_must_match_exactly() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin", "session", "/login")],
            ..Default::default()
        });
        assert!(matches!(
            rules.apply("/admin", Some("sessionx=1; xsession=2")),
            RuleOutcome::Redirect { .. }
        ));
    }

    #[test]
    fn guard_with_param_pattern_covers_subpaths() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin/*rest", "session", "/")],
            ..Default::default()
        });
        assert!(matches!(
            rules.apply("/admin/users/42", None),
            RuleOutcome::Redirect { .. }
        ));
        assert_eq!(rules.apply("/public-page", None), RuleOutcome::None);
    }

    // ── phase and rule ordering ──────────────────────────────────────────────

    #[test]
    fn guards_run_before_redirects_before_rewrites() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/target", "session", "/from-guard")],
            redirects: vec![redirect("/target", "/from-redirect", 302)],
            rewrites: vec![RewriteRule {
                from: "/target".to_string(),
                to: "/from-rewrite".to_string(),
            }],
            headers: Vec::new(),
        });
        assert_eq!(
            rules.apply("/target", None),
            RuleOutcome::Redirect {
                location: "/from-guard".to_string(),
                status: StatusCode::FOUND
            }
        );
        assert_eq!(
            rules.apply("/target", Some("session=x")),
            RuleOutcome::Redirect {
                location: "/from-redirect".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn first_matching_rule_wins_within_a_phase() {
        let rules = RuleSet::compile(&MiddlewareRules {
            redirects: vec![
                redirect("/posts/:id", "/first/:id", 302),
                redirect("/posts/:id", "/second/:id", 302),
            ],
            ..Default::default()
        });
        assert_eq!(
            rules.apply("/posts/7", None),
            RuleOutcome::Redirect {
                location: "/first/7".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn merged_evaluation_checks_static_before_worker_per_phase() {
        let static_rules = rules_with_redirect("/dup", "/from-static", 302);
        let worker_rules = rules_with_redirect("/dup", "/from-worker", 302);
        assert_eq!(
            apply_merged(&static_rules, &worker_rules, "/dup", None),
            RuleOutcome::Redirect {
                location: "/from-static".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn merged_evaluation_keeps_phase_order_across_sets() {
        // A worker guard must beat a static redirect on the same path.
        let static_rules = rules_with_redirect("/admin", "/from-static-redirect", 302);
        let worker_rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin", "session", "/from-worker-guard")],
            ..Default::default()
        });
        assert_eq!(
            apply_merged(&static_rules, &worker_rules, "/admin", None),
            RuleOutcome::Redirect {
                location: "/from-worker-guard".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    // ── header rules ─────────────────────────────────────────────────────────

    #[test]
    fn header_rules_stamp_all_matching_rules() {
        let rules = RuleSet::compile(&MiddlewareRules {
            headers: vec![
                HeaderRule {
                    path: "/docs/*rest".to_string(),
                    headers: [("x-docs".to_string(), "1".to_string())].into(),
                },
                HeaderRule {
                    path: "/docs/secure".to_string(),
                    headers: [("x-frame-options".to_string(), "DENY".to_string())].into(),
                },
            ],
            ..Default::default()
        });
        let stamped = rules.response_headers("/docs/secure");
        assert_eq!(stamped.len(), 2);
        assert!(rules.response_headers("/elsewhere").is_empty());
    }

    #[test]
    fn invalid_header_value_is_rejected_at_load_not_request_time() {
        let rules = RuleSet::compile(&MiddlewareRules {
            headers: vec![HeaderRule {
                path: "/x".to_string(),
                headers: [("x-bad".to_string(), "evil\r\ninjected: 1".to_string())].into(),
            }],
            ..Default::default()
        });
        assert!(!rules.has_header_rules());
        assert!(rules.response_headers("/x").is_empty());
    }

    #[test]
    fn invalid_header_name_is_rejected_at_load() {
        let rules = RuleSet::compile(&MiddlewareRules {
            headers: vec![HeaderRule {
                path: "/x".to_string(),
                headers: [("bad name".to_string(), "v".to_string())].into(),
            }],
            ..Default::default()
        });
        assert!(!rules.has_header_rules());
    }

    // ── query preservation ───────────────────────────────────────────────────

    #[test]
    fn query_string_is_appended_verbatim() {
        assert_eq!(
            with_query("/cached".to_string(), Some("a=1&b=two")),
            "/cached?a=1&b=two"
        );
        assert_eq!(with_query("/cached".to_string(), Some("")), "/cached");
        assert_eq!(with_query("/cached".to_string(), None), "/cached");
    }

    // ── wire-format deserialization ──────────────────────────────────────────

    #[test]
    fn guard_deserializes_from_camel_case_ready_frame_json() {
        let raw: MiddlewareRules = serde_json::from_str(
            r#"{"guards":[{"path":"/admin","requireCookie":"session","redirectTo":"/"}]}"#,
        )
        .expect("camelCase guard json");
        assert_eq!(raw.guards.len(), 1);
        assert_eq!(raw.guards[0].require_cookie, "session");
        assert_eq!(raw.guards[0].redirect_to, "/");
    }

    #[test]
    fn empty_middleware_rules_compile_to_an_empty_set() {
        let rules = RuleSet::compile(&MiddlewareRules::default());
        assert!(rules.is_empty());
        assert_eq!(rules.apply("/anything", None), RuleOutcome::None);
    }
}
