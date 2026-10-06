//! giojs-server/src/rules.rs
//!
//! Declarative middleware rules (redirects, rewrites, response headers, auth
//! guards) executed in the Rust HTTP layer before routing and before any Node
//! code. Rules come from gio.toml (static) and from the worker's READY frame
//! (middleware.ts). Patterns share the routing conventions: literal segments,
//! `:param` captures, `*rest` catch-all (zero or more segments, so
//! `/admin/*rest` also covers `/admin` itself). Callers match the canonical
//! request path (path_hygiene.rs). Evaluation order per request:
//! guards, then redirects, then rewrites - first match wins within each phase,
//! and when two rule sets are merged the static (gio.toml) set is checked
//! before the worker set inside every phase. Header rules stamp responses
//! independently of the short-circuiting phases. All header names/values and
//! redirect statuses are validated once at compile/load time (invalid entries
//! are skipped with a warning), never at request time.

use std::sync::Arc;

use axum::http::{HeaderName, HeaderValue, StatusCode};
use serde::Deserialize;
use thiserror::Error;
use tracing::{error, warn};

use crate::session_token::{self, SessionKeys};

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
/// (camelCase aliases). A request to a matching path without the credential
/// is redirected (302) and never reaches Node. `require_cookie` alone asks
/// for a non-empty cookie of that name. `require_session = true` asks for a
/// valid session token (MAC and expiry, see session_token.rs) in the cookie
/// `require_cookie` names, `gio_session` by default.
#[derive(Debug, Clone, Deserialize)]
pub struct GuardRule {
    pub path: String,
    #[serde(alias = "requireCookie", default)]
    pub require_cookie: String,
    #[serde(alias = "requireSession", default)]
    pub require_session: bool,
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
    /// may be empty: `/admin/*rest` matches `/admin` too, the same way the
    /// Node router's catch-all does - a guard on a section must not leave
    /// the section's index page open. `None` allocates nothing for patterns
    /// without captures.
    fn match_path<'p>(&self, path: &'p str) -> Option<Vec<&'p str>> {
        let mut captures: Vec<&'p str> = Vec::new();
        let mut rest = path.trim_start_matches('/');
        for segment in &self.segments {
            if *segment == Segment::CatchAll {
                captures.push(rest.trim_end_matches('/'));
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

    /// An empty capture (a catch-all that matched zero segments) contributes
    /// no segment at all: `/old/*rest -> /new/*rest` sends `/old` to `/new`,
    /// not `/new/`.
    fn expand(&self, captures: &[&str]) -> String {
        let mut target = String::new();
        for part in &self.parts {
            match part {
                TemplatePart::Literal(literal) => {
                    target.push('/');
                    target.push_str(literal);
                }
                TemplatePart::Capture(index) => {
                    let value = captures.get(*index).copied().unwrap_or("");
                    if !value.is_empty() {
                        target.push('/');
                        target.push_str(value);
                    }
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

/// What a guard demands of the named cookie.
#[derive(Debug)]
enum GuardCheck {
    /// Any non-empty value.
    Cookie(String),
    /// A session token signed with GIO_SESSION_SECRET and not yet expired.
    Session(String),
}

#[derive(Debug)]
struct CompiledGuard {
    pattern: Pattern,
    check: GuardCheck,
    redirect_to: String,
}

impl CompiledGuard {
    fn compile(rule: &GuardRule) -> Result<Self, RuleError> {
        let check = if rule.require_session {
            let cookie = if rule.require_cookie.is_empty() {
                session_token::DEFAULT_COOKIE_NAME
            } else {
                &rule.require_cookie
            };
            GuardCheck::Session(cookie.to_string())
        } else if rule.require_cookie.is_empty() {
            return Err(RuleError::EmptyField("require_cookie"));
        } else {
            GuardCheck::Cookie(rule.require_cookie.clone())
        };
        if !rule.redirect_to.starts_with('/') {
            return Err(RuleError::PatternNotAbsolute(rule.redirect_to.clone()));
        }
        Ok(CompiledGuard {
            pattern: Pattern::compile(&rule.path)?,
            check,
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
    /// Verifies `require_session` guards; `None` makes them deny everything.
    session_keys: Option<Arc<SessionKeys>>,
}

impl RuleSet {
    /// Compile raw rules, skipping (with a warning) any entry that fails
    /// validation. This is the load-time gate: nothing after this point can
    /// fail or panic at request time. Session guards verify with the
    /// process-wide secrets from `session_token::init`.
    pub fn compile(raw: &MiddlewareRules) -> Self {
        Self::compile_with_session_keys(raw, session_token::keys())
    }

    pub fn compile_with_session_keys(
        raw: &MiddlewareRules,
        session_keys: Option<Arc<SessionKeys>>,
    ) -> Self {
        let mut compiled = RuleSet {
            session_keys,
            ..RuleSet::default()
        };
        for rule in &raw.guards {
            match CompiledGuard::compile(rule) {
                Ok(guard) => {
                    // Fail closed, loudly: without a secret no session can be
                    // verified, so the guard turns every request away.
                    if matches!(guard.check, GuardCheck::Session(_))
                        && compiled.session_keys.is_none()
                    {
                        error!(
                            path = %rule.path,
                            "require_session guard without a valid {} - it denies every request. Generate a secret with: {}",
                            session_token::SECRET_ENV,
                            session_token::SECRET_GENERATE_HINT
                        );
                    }
                    compiled.guards.push(guard);
                }
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
            let authorized = match &guard.check {
                GuardCheck::Cookie(name) => cookie_header
                    .map(|cookies| cookie_has_value(cookies, name))
                    .unwrap_or(false),
                GuardCheck::Session(name) => {
                    match (
                        &self.session_keys,
                        cookie_header.and_then(|c| first_cookie_value(c, name)),
                    ) {
                        (Some(keys), Some(token)) => {
                            keys.verify(name, token, session_token::now_unix())
                        }
                        _ => false,
                    }
                }
            };
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

/// Only the guard phase, across both sets in the same order as
/// `apply_merged`. For a second URL of the same resource - a public/ file
/// answered at the site root is also `/public/...` - access control follows
/// the resource, while redirects and rewrites stay about the URL that was
/// requested: a `/public/*rest` -> `/*rest` redirect canonicalizing old URLs
/// must not fire for (and loop on) its own target.
pub fn check_guards_merged(
    static_rules: &RuleSet,
    worker_rules: &RuleSet,
    path: &str,
    cookie_header: Option<&str>,
) -> Option<RuleOutcome> {
    [static_rules, worker_rules]
        .into_iter()
        .find_map(|rules| rules.check_guards(path, cookie_header))
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

/// The first value of cookie `name`, trimmed - the occurrence the Node
/// worker's parseCookies (and so getSession) reads, so a guard and the page
/// behind it judge the same token.
fn first_cookie_value<'h>(cookie_header: &'h str, name: &str) -> Option<&'h str> {
    cookie_header
        .split(';')
        .find_map(|pair| match pair.split_once('=') {
            Some((key, value)) if key.trim() == name => Some(value.trim()),
            _ => None,
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
            require_session: false,
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
    fn catch_all_matches_zero_segments() {
        let rules = rules_with_rewrite("/docs/*rest", "/guide/*rest");
        for path in ["/docs", "/docs/"] {
            assert_eq!(
                rules.apply(path, None),
                RuleOutcome::Rewrite {
                    new_path: "/guide".to_string()
                },
                "{path}"
            );
        }
        assert_eq!(rules.apply("/docsx", None), RuleOutcome::None);
        assert_eq!(rules.apply("/", None), RuleOutcome::None);
    }

    #[test]
    fn empty_catch_all_drops_its_segment_from_redirect_targets() {
        let rules = rules_with_redirect("/old/*rest", "/new/:rest", 301);
        assert_eq!(
            rules.apply("/old", None),
            RuleOutcome::Redirect {
                location: "/new".to_string(),
                status: StatusCode::MOVED_PERMANENTLY
            }
        );
        assert_eq!(
            rules.apply("/old/a/b", None),
            RuleOutcome::Redirect {
                location: "/new/a/b".to_string(),
                status: StatusCode::MOVED_PERMANENTLY
            }
        );
        // A target that is nothing but the empty capture resolves to root.
        let to_root = rules_with_redirect("/legacy/*rest", "/*rest", 302);
        assert_eq!(
            to_root.apply("/legacy", None),
            RuleOutcome::Redirect {
                location: "/".to_string(),
                status: StatusCode::FOUND
            }
        );
    }

    #[test]
    fn root_catch_all_covers_every_path_including_root() {
        let rules = RuleSet::compile(&MiddlewareRules {
            headers: vec![HeaderRule {
                path: "/*rest".to_string(),
                headers: [("x-frame-options".to_string(), "DENY".to_string())].into(),
            }],
            ..Default::default()
        });
        for path in ["/", "/about", "/a/b/c"] {
            assert_eq!(rules.response_headers(path).len(), 1, "{path}");
        }
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

    #[test]
    fn section_guard_also_covers_the_section_index() {
        let rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/admin/*rest", "session", "/login")],
            ..Default::default()
        });
        assert!(matches!(
            rules.apply("/admin", None),
            RuleOutcome::Redirect { .. }
        ));
        assert_eq!(rules.apply("/admin", Some("session=x")), RuleOutcome::None);
        assert_eq!(rules.apply("/administrator", None), RuleOutcome::None);
    }

    // ── session guards ───────────────────────────────────────────────────────

    const SECRET: &str = "rules-test-session-secret-0123456789abcdef";
    const OTHER_SECRET: &str = "rules-test-session-secret-other-0123456789";

    fn session_guard(path: &str, cookie: &str) -> GuardRule {
        GuardRule {
            path: path.to_string(),
            require_cookie: cookie.to_string(),
            require_session: true,
            redirect_to: "/login".to_string(),
        }
    }

    fn session_rules(guards: Vec<GuardRule>, secrets: Option<&str>) -> RuleSet {
        let keys = secrets
            .map(|raw| Arc::new(SessionKeys::from_secret_list(raw).expect("valid test secrets")));
        RuleSet::compile_with_session_keys(
            &MiddlewareRules {
                guards,
                ..Default::default()
            },
            keys,
        )
    }

    fn token(secret: &str, cookie: &str, exp: u64) -> String {
        session_token::sign_for_tests(secret, cookie, exp, "c2VhbGVkLWRhdGE")
    }

    fn future() -> u64 {
        session_token::now_unix() + 3600
    }

    #[test]
    fn session_guard_passes_only_a_valid_unexpired_token() {
        let rules = session_rules(vec![session_guard("/admin/*rest", "")], Some(SECRET));
        let valid = format!(
            "a=1; gio_session={}",
            token(SECRET, "gio_session", future())
        );
        assert_eq!(rules.apply("/admin/users", Some(&valid)), RuleOutcome::None);

        let expired = format!(
            "gio_session={}",
            token(SECRET, "gio_session", 1_000_000_000)
        );
        let forged = format!(
            "gio_session={}",
            token(OTHER_SECRET, "gio_session", future())
        );
        let other_cookie = format!("gio_session={}", token(SECRET, "admin_session", future()));
        for header in [
            None,
            Some("gio_session=valid"),
            Some("gio_session="),
            Some(expired.as_str()),
            Some(forged.as_str()),
            Some(other_cookie.as_str()),
        ] {
            assert_eq!(
                rules.apply("/admin/users", header),
                RuleOutcome::Redirect {
                    location: "/login".to_string(),
                    status: StatusCode::FOUND
                },
                "{header:?}"
            );
        }
    }

    #[test]
    fn session_guard_reads_the_first_cookie_occurrence_like_node() {
        let rules = session_rules(vec![session_guard("/admin", "")], Some(SECRET));
        let good = token(SECRET, "gio_session", future());
        assert_eq!(
            rules.apply(
                "/admin",
                Some(&format!("gio_session={good}; gio_session=junk"))
            ),
            RuleOutcome::None
        );
        assert!(matches!(
            rules.apply(
                "/admin",
                Some(&format!("gio_session=junk; gio_session={good}"))
            ),
            RuleOutcome::Redirect { .. }
        ));
    }

    #[test]
    fn session_guard_cookie_name_is_overridable() {
        let rules = session_rules(vec![session_guard("/staff", "staff_sess")], Some(SECRET));
        let staff = format!("staff_sess={}", token(SECRET, "staff_sess", future()));
        assert_eq!(rules.apply("/staff", Some(&staff)), RuleOutcome::None);
        let default_cookie = format!("gio_session={}", token(SECRET, "gio_session", future()));
        assert!(matches!(
            rules.apply("/staff", Some(&default_cookie)),
            RuleOutcome::Redirect { .. }
        ));
    }

    #[test]
    fn session_guard_accepts_rotated_secrets() {
        let rotated = format!("{OTHER_SECRET},{SECRET}");
        let rules = session_rules(vec![session_guard("/admin", "")], Some(&rotated));
        let old = format!("gio_session={}", token(SECRET, "gio_session", future()));
        assert_eq!(rules.apply("/admin", Some(&old)), RuleOutcome::None);
    }

    #[test]
    fn session_guard_without_a_secret_fails_closed() {
        let rules = session_rules(vec![session_guard("/admin", "")], None);
        assert!(!rules.is_empty(), "the guard is kept, not skipped");
        let cookie = format!("gio_session={}", token(SECRET, "gio_session", future()));
        assert!(matches!(
            rules.apply("/admin", Some(&cookie)),
            RuleOutcome::Redirect { .. }
        ));
        assert_eq!(rules.apply("/public", None), RuleOutcome::None);
    }

    #[test]
    fn guard_needs_a_cookie_or_a_session_requirement() {
        let rules = session_rules(
            vec![GuardRule {
                path: "/admin".to_string(),
                require_cookie: String::new(),
                require_session: false,
                redirect_to: "/".to_string(),
            }],
            Some(SECRET),
        );
        assert!(rules.is_empty());
    }

    #[test]
    fn session_guard_parses_from_gio_toml_and_the_ready_frame() {
        let from_toml: MiddlewareRules = toml::from_str(
            "[[guards]]\npath = \"/admin/*rest\"\nrequire_session = true\nredirect_to = \"/login\"\n",
        )
        .expect("toml guard");
        assert!(from_toml.guards[0].require_session);
        assert_eq!(from_toml.guards[0].require_cookie, "");
        let from_json: MiddlewareRules = serde_json::from_str(
            r#"{"guards":[{"path":"/a","requireSession":true,"requireCookie":"s","redirectTo":"/"}]}"#,
        )
        .expect("json guard");
        assert!(from_json.guards[0].require_session);
        assert_eq!(from_json.guards[0].require_cookie, "s");
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

    #[test]
    fn guard_only_evaluation_ignores_redirects_and_rewrites() {
        let static_rules = RuleSet::compile(&MiddlewareRules {
            redirects: vec![redirect("/public/*rest", "/*rest", 301)],
            rewrites: vec![RewriteRule {
                from: "/public/old/*rest".to_string(),
                to: "/public/new/*rest".to_string(),
            }],
            ..Default::default()
        });
        let worker_rules = RuleSet::compile(&MiddlewareRules {
            guards: vec![guard("/public/members/*rest", "session", "/login")],
            ..Default::default()
        });
        assert_eq!(
            check_guards_merged(&static_rules, &worker_rules, "/public/members/a.txt", None),
            Some(RuleOutcome::Redirect {
                location: "/login".to_string(),
                status: StatusCode::FOUND
            })
        );
        assert_eq!(
            check_guards_merged(
                &static_rules,
                &worker_rules,
                "/public/members/a.txt",
                Some("session=abc")
            ),
            None
        );
        assert_eq!(
            check_guards_merged(&static_rules, &worker_rules, "/public/old/a.txt", None),
            None
        );
        assert_eq!(
            check_guards_merged(&static_rules, &worker_rules, "/public/robots.txt", None),
            None
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
