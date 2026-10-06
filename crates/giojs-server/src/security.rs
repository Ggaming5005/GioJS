//! giojs-server/src/security.rs
//!
//! The framework's own security policy, configured by gio.toml `[security]`:
//!
//! - Default response headers (nosniff, frame options, referrer policy, and
//!   HSTS when TLS is on), stamped on every response at serve time by
//!   `security_headers_middleware` - never stored in the page cache, so a
//!   config change reaches cached pages at once. A header the response
//!   already carries wins (route.ts and getServerSideProps headers,
//!   `[[headers]]` / middleware.ts rules); such a header with an EMPTY value
//!   removes the default from that response. `x-powered-by` is always
//!   stripped.
//! - Content-Security-Policy with per-response nonces. Pages are cached and
//!   PPR shells replayed, so a render cannot know the nonce of the response
//!   that will carry it: the worker renders with a secret placeholder, and
//!   this layer swaps it for a fresh nonce in the body and headers of every
//!   dynamic response - buffered, cached, streamed, PPR shell + holes alike -
//!   before compression. The placeholder is random, persisted beside the
//!   page cache (so the disk cache survives restarts) and never sent to a
//!   client: markup an attacker manages to store cannot name it, so it can
//!   never be promoted to a valid nonce.
//! - Cross-site request protection: unsafe methods and WebSocket upgrades
//!   are refused when the browser reports another site (Sec-Fetch-Site), or,
//!   without that header, when Origin names another host than the request's.
//!   Requests carrying neither header are not from a browser page and cannot
//!   be forged cross-site, so they pass.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use hyper::body::Body as _;
use thiserror::Error;
use tokio_stream::Stream;
use tracing::warn;

use crate::config::{default_hsts_max_age, HstsSetting, SecurityConfig};
use crate::rules::{PathPattern, RuleError};

/// Worker environment variable carrying the nonce placeholder.
pub const NONCE_PLACEHOLDER_ENV: &str = "GIO_CSP_NONCE_PLACEHOLDER";

/// File (inside the placeholder directory) persisting the placeholder.
const PLACEHOLDER_FILE: &str = "csp-nonce-placeholder";

/// Hex characters in a placeholder (128 bits).
const PLACEHOLDER_LEN: usize = 32;

/// Random bytes in a nonce (144 bits; 24 base64 characters, no padding).
const NONCE_BYTES: usize = 18;

/// Bodies with a known length up to this size are rewritten in one pass and
/// keep a Content-Length; anything else is rewritten as a stream.
const MAX_BUFFERED_SUBSTITUTION: u64 = 16 * 1024 * 1024;

/// Distinct rejected origins logged at warn level before the check goes
/// quiet (debug level) - a hostile page can loop requests at us.
const MAX_WARNED_ORIGINS: usize = 64;

#[derive(Debug, Error)]
pub enum SecurityConfigError {
    #[error("[security.headers] {0:?} is not a valid header name")]
    InvalidHeaderName(String),
    #[error("[security.headers] {0}: invalid header value")]
    InvalidHeaderValue(String),
    #[error("[security.headers] cannot set {0} - use [security] {1} instead")]
    ReservedHeader(String, &'static str),
    #[error("[security] {0}: invalid header value")]
    InvalidPolicy(&'static str),
    #[error(
        "[security.csrf] trusted_origins entry {0:?} is not an origin such as \
         \"https://admin.example.com\" (scheme http or https, no path)"
    )]
    InvalidTrustedOrigin(String),
    #[error("[security.csrf] exempt entry {0:?}: {1}")]
    InvalidExempt(String, RuleError),
}

// ── Nonce placeholder ─────────────────────────────────────────────────────────

/// Process-wide placeholder, installed once at startup before the worker is
/// spawned and before any response is built. Global because every framework
/// inline tag needs it - deployment script, critical CSS, dev overlay, error
/// pages - across modules that otherwise share no state.
static SCRIPT_NONCE: OnceLock<ScriptNonce> = OnceLock::new();

struct ScriptNonce {
    placeholder: String,
    attr: String,
}

/// Make the framework's inline tags carry the placeholder nonce (and hand it
/// to the worker). Only the first call has an effect.
pub fn install_nonce_placeholder(placeholder: &str) {
    let _ = SCRIPT_NONCE.set(ScriptNonce {
        placeholder: placeholder.to_string(),
        attr: nonce_attr_for(placeholder),
    });
}

/// The installed placeholder; None when CSP nonces are off.
pub fn nonce_placeholder() -> Option<&'static str> {
    SCRIPT_NONCE.get().map(|nonce| nonce.placeholder.as_str())
}

/// ` nonce="<placeholder>"` for a framework inline `<script>`/`<style>`,
/// or "" when CSP nonces are off.
pub fn nonce_attr() -> &'static str {
    SCRIPT_NONCE.get().map_or("", |nonce| nonce.attr.as_str())
}

fn nonce_attr_for(placeholder: &str) -> String {
    if placeholder.is_empty() {
        String::new()
    } else {
        format!(" nonce=\"{placeholder}\"")
    }
}

/// `<script ...>` / `<style ...>` markup with the nonce attribute added to
/// its opening tag. `markup` must start with the tag name (`<script`).
pub fn with_nonce_attr(markup: &str, tag: &str, attr: &str) -> String {
    match markup.strip_prefix(tag) {
        Some(rest) if !attr.is_empty() => format!("{tag}{attr}{rest}"),
        _ => markup.to_string(),
    }
}

/// The placeholder persisted under `dir`, created on first use. Persisting
/// keeps disk-cached pages (which contain it) servable across restarts.
/// Falls back to a per-process placeholder when the directory is not
/// writable - correct, only the disk cache is then lost at the next start
/// (cache entries are stamped with the placeholder's fingerprint, see
/// `cache_epoch`).
pub fn load_or_create_nonce_placeholder(dir: &Path) -> String {
    let path = dir.join(PLACEHOLDER_FILE);
    let fresh = generate_placeholder();
    // The second attempt follows the removal of a corrupt file.
    for _ in 0..2 {
        if let Some(existing) = read_placeholder(&path) {
            return existing;
        }
        match create_placeholder_file(dir, &path, &fresh) {
            Ok(()) => return fresh,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Another instance sharing the cache just won the race (its
                // file is complete: it was linked into place fully written),
                // or the file is corrupt and must go.
                if let Some(existing) = read_placeholder(&path) {
                    return existing;
                }
                let _ = std::fs::remove_file(&path);
            }
            Err(e) => {
                warn!(path = %path.display(), error = %e, "cannot persist the CSP nonce placeholder - the disk page cache will not survive a restart");
                return fresh;
            }
        }
    }
    fresh
}

fn read_placeholder(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value = raw.trim();
    is_valid_placeholder(value).then(|| value.to_string())
}

/// Write `value` to a private temp file, then hard-link it into place: the
/// link fails if the file exists, and a reader never sees it half-written.
fn create_placeholder_file(dir: &Path, path: &Path, value: &str) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        "{PLACEHOLDER_FILE}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(value.as_bytes()));
    let linked = written.and_then(|()| std::fs::hard_link(&tmp, path));
    let _ = std::fs::remove_file(&tmp);
    linked
}

fn is_valid_placeholder(value: &str) -> bool {
    value.len() == PLACEHOLDER_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 32 hex characters from two v4 UUIDs (OS CSPRNG) through SHA-256.
fn generate_placeholder() -> String {
    random_bytes()[..PLACEHOLDER_LEN / 2]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn random_bytes() -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    hasher.finalize().into()
}

/// A fresh nonce for one response: 144 random bits, base64.
pub fn generate_nonce() -> String {
    crate::ws_ipc::b64::encode(&random_bytes()[..NONCE_BYTES])
}

/// The value stamped into every cache entry's deployment-id slot and
/// required on lookup. With nonces on, cached HTML contains the placeholder,
/// so an entry is only servable by a process substituting that same
/// placeholder: entries from before CSP was enabled (no nonce attributes),
/// after it was disabled (an unsubstituted placeholder would leak), or under
/// another placeholder are misses - and deleted.
pub fn cache_epoch(deployment_id: &str, placeholder: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    match placeholder {
        None => deployment_id.to_string(),
        Some(placeholder) => {
            let digest = Sha256::digest(placeholder.as_bytes());
            let fingerprint: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
            format!("{deployment_id}+csp-{fingerprint}")
        }
    }
}

// ── Placeholder substitution ──────────────────────────────────────────────────

/// Replaces the placeholder with the nonce in a byte stream whose chunk
/// boundaries may split the placeholder: a chunk tail that could be the start
/// of one is held back until the next chunk (or the end) decides.
#[derive(Debug)]
pub struct NonceReplacer {
    placeholder: Bytes,
    nonce: Bytes,
    carry: BytesMut,
}

impl NonceReplacer {
    pub fn new(placeholder: Bytes, nonce: Bytes) -> Self {
        NonceReplacer {
            placeholder,
            nonce,
            carry: BytesMut::new(),
        }
    }

    /// Replace every occurrence in a complete body.
    pub fn replace_all(&self, body: Bytes) -> Bytes {
        if find(&body, &self.placeholder).is_none() {
            return body;
        }
        let mut out = BytesMut::with_capacity(body.len());
        let rest_start = self.replace_into(&body, &mut out);
        out.extend_from_slice(&body[rest_start..]);
        out.freeze()
    }

    /// Feed one chunk; returns bytes ready to send (None when everything was
    /// held back).
    pub fn feed(&mut self, chunk: Bytes) -> Option<Bytes> {
        if self.carry.is_empty()
            && find(&chunk, &self.placeholder).is_none()
            && partial_prefix_len(&chunk, &self.placeholder) == 0
        {
            // Fast path: nothing to replace or hold - pass the chunk through.
            return (!chunk.is_empty()).then_some(chunk);
        }
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(&chunk);
        let mut out = BytesMut::with_capacity(data.len());
        let rest_start = self.replace_into(&data, &mut out);
        let rest = &data[rest_start..];
        let keep = partial_prefix_len(rest, &self.placeholder);
        out.extend_from_slice(&rest[..rest.len() - keep]);
        self.carry.extend_from_slice(&rest[rest.len() - keep..]);
        (!out.is_empty()).then(|| out.freeze())
    }

    /// End of stream: whatever was held back was not a placeholder.
    pub fn finish(&mut self) -> Option<Bytes> {
        let remaining = std::mem::take(&mut self.carry);
        (!remaining.is_empty()).then(|| remaining.freeze())
    }

    /// Copy `data` into `out` with every complete placeholder replaced, up
    /// to the end of the last match. Returns the offset of the unconsumed rest.
    fn replace_into(&self, data: &[u8], out: &mut BytesMut) -> usize {
        let mut start = 0;
        while let Some(pos) = find(&data[start..], &self.placeholder) {
            out.extend_from_slice(&data[start..start + pos]);
            out.extend_from_slice(&self.nonce);
            start += pos + self.placeholder.len();
        }
        start
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let first = *needle.first()?;
    let mut offset = 0;
    while offset + needle.len() <= haystack.len() {
        let pos = haystack[offset..=haystack.len() - needle.len()]
            .iter()
            .position(|&b| b == first)?;
        let candidate = offset + pos;
        if &haystack[candidate..candidate + needle.len()] == needle {
            return Some(candidate);
        }
        offset = candidate + 1;
    }
    None
}

/// Length of the longest tail of `data` that is a proper prefix of `needle`.
fn partial_prefix_len(data: &[u8], needle: &[u8]) -> usize {
    let max = needle.len().saturating_sub(1).min(data.len());
    (1..=max)
        .rev()
        .find(|&k| data[data.len() - k..] == needle[..k])
        .unwrap_or(0)
}

/// Response body stream with the placeholder replaced chunk by chunk.
struct NonceBodyStream {
    inner: axum::body::BodyDataStream,
    replacer: NonceReplacer,
    done: bool,
}

impl Stream for NonceBodyStream {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if this.done {
                return Poll::Ready(None);
            }
            match Pin::new(&mut this.inner).poll_next(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    if let Some(out) = this.replacer.feed(chunk) {
                        return Poll::Ready(Some(Ok(out)));
                    }
                }
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Some(Err(e))),
                Poll::Ready(None) => {
                    this.done = true;
                    return Poll::Ready(this.replacer.finish().map(Ok));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

// ── Policy ────────────────────────────────────────────────────────────────────

/// A CSP header whose `{nonce}` slots are filled per response.
#[derive(Debug)]
struct CspTemplate {
    name: HeaderName,
    template: String,
    uses_nonce: bool,
}

impl CspTemplate {
    /// Whitespace runs (a multi-line TOML string) collapse to one space; an
    /// empty policy is no policy.
    fn compile(
        name: HeaderName,
        raw: Option<&str>,
        key: &'static str,
    ) -> Result<Option<Self>, SecurityConfigError> {
        let Some(raw) = raw else {
            return Ok(None);
        };
        let template = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if template.is_empty() {
            return Ok(None);
        }
        let uses_nonce = template.contains("{nonce}");
        // Validated with a real-shaped nonce so request time cannot fail.
        HeaderValue::from_str(&template.replace("{nonce}", &generate_nonce()))
            .map_err(|_| SecurityConfigError::InvalidPolicy(key))?;
        Ok(Some(CspTemplate {
            name,
            template,
            uses_nonce,
        }))
    }

    fn value(&self, nonce: &mut LazyNonce) -> Option<HeaderValue> {
        let value = if self.uses_nonce {
            self.template.replace("{nonce}", nonce.get())
        } else {
            self.template.clone()
        };
        HeaderValue::from_str(&value).ok()
    }
}

/// One nonce per response, generated only when something needs it.
#[derive(Default)]
struct LazyNonce(Option<String>);

impl LazyNonce {
    fn get(&mut self) -> &str {
        self.0.get_or_insert_with(generate_nonce)
    }
}

/// The compiled `[security]` section.
#[derive(Debug)]
pub struct SecurityPolicy {
    /// Stamped when the response does not set them (HSTS included when it
    /// applies). CSP lives in `csp` / `csp_report_only`.
    defaults: Vec<(HeaderName, HeaderValue)>,
    csp: Option<CspTemplate>,
    csp_report_only: Option<CspTemplate>,
    /// Set when nonces are on (`with_nonce_placeholder`).
    placeholder: Option<Bytes>,
    csrf: CsrfPolicy,
}

const DEFAULT_HEADERS: [(&str, &str); 3] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "SAMEORIGIN"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
];

impl SecurityPolicy {
    /// Compile and validate the section. Any invalid entry is a startup
    /// error: a security setting that silently does nothing is worse than
    /// one that refuses to start.
    pub fn new(cfg: &SecurityConfig, tls_enabled: bool) -> Result<Self, SecurityConfigError> {
        let mut defaults: Vec<(HeaderName, HeaderValue)> = DEFAULT_HEADERS
            .iter()
            .map(|(name, value)| {
                (
                    HeaderName::from_static(name),
                    HeaderValue::from_static(value),
                )
            })
            .collect();
        if let Some(hsts) = hsts_value(cfg.hsts.as_ref(), tls_enabled) {
            let value = HeaderValue::from_str(&hsts)
                .map_err(|_| SecurityConfigError::InvalidPolicy("hsts"))?;
            defaults.push((header::STRICT_TRANSPORT_SECURITY, value));
        }
        for (raw_name, raw_value) in &cfg.headers {
            let name = HeaderName::from_bytes(raw_name.trim().as_bytes())
                .map_err(|_| SecurityConfigError::InvalidHeaderName(raw_name.clone()))?;
            if name == header::CONTENT_SECURITY_POLICY {
                return Err(SecurityConfigError::ReservedHeader(raw_name.clone(), "csp"));
            }
            if name == header::CONTENT_SECURITY_POLICY_REPORT_ONLY {
                return Err(SecurityConfigError::ReservedHeader(
                    raw_name.clone(),
                    "csp_report_only",
                ));
            }
            if name == header::STRICT_TRANSPORT_SECURITY {
                return Err(SecurityConfigError::ReservedHeader(
                    raw_name.clone(),
                    "hsts",
                ));
            }
            defaults.retain(|(existing, _)| *existing != name);
            let value = raw_value.trim();
            if value.is_empty() {
                continue;
            }
            let value = HeaderValue::from_str(value)
                .map_err(|_| SecurityConfigError::InvalidHeaderValue(raw_name.clone()))?;
            defaults.push((name, value));
        }
        Ok(SecurityPolicy {
            defaults,
            csp: CspTemplate::compile(header::CONTENT_SECURITY_POLICY, cfg.csp.as_deref(), "csp")?,
            csp_report_only: CspTemplate::compile(
                header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
                cfg.csp_report_only.as_deref(),
                "csp_report_only",
            )?,
            placeholder: None,
            csrf: CsrfPolicy::new(&cfg.csrf)?,
        })
    }

    /// Whether a configured policy contains `{nonce}`: the worker must then
    /// render with the placeholder and responses get substituted.
    pub fn uses_nonces(&self) -> bool {
        [&self.csp, &self.csp_report_only]
            .into_iter()
            .flatten()
            .any(|csp| csp.uses_nonce)
    }

    /// Turn on placeholder substitution (call when `uses_nonces`).
    pub fn with_nonce_placeholder(mut self, placeholder: &str) -> Self {
        self.placeholder = Some(Bytes::copy_from_slice(placeholder.as_bytes()));
        self
    }

    pub fn csrf(&self) -> &CsrfPolicy {
        &self.csrf
    }

    /// Names of the default headers, for the startup log line.
    pub fn default_header_names(&self) -> Vec<&str> {
        self.defaults
            .iter()
            .map(|(name, _)| name.as_str())
            .collect()
    }

    pub fn has_csp(&self) -> bool {
        self.csp.is_some()
    }

    pub fn has_csp_report_only(&self) -> bool {
        self.csp_report_only.is_some()
    }

    /// Stamp the defaults and CSP onto a response and substitute the nonce
    /// placeholder (headers and, for dynamic text responses, the body).
    pub async fn secure_response(&self, mut resp: Response) -> Response {
        let mut nonce = LazyNonce::default();
        let headers = resp.headers_mut();
        headers.remove(HeaderName::from_static("x-powered-by"));
        for (name, value) in &self.defaults {
            stamp_default(headers, name, || Some(value.clone()));
        }
        for csp in [&self.csp, &self.csp_report_only].into_iter().flatten() {
            stamp_default(headers, &csp.name, || csp.value(&mut nonce));
        }
        let Some(placeholder) = self.placeholder.clone() else {
            return resp;
        };
        substitute_header_values(resp.headers_mut(), &placeholder, &mut nonce);
        if !substitutes_body(resp.headers()) {
            return resp;
        }
        let replacer = NonceReplacer::new(placeholder, Bytes::from(nonce.get().to_string()));
        let (mut parts, body) = resp.into_parts();
        // The nonce and the placeholder differ in length.
        parts.headers.remove(header::CONTENT_LENGTH);
        let body = match body.size_hint().exact() {
            Some(len) if len <= MAX_BUFFERED_SUBSTITUTION => {
                match axum::body::to_bytes(body, MAX_BUFFERED_SUBSTITUTION as usize).await {
                    Ok(bytes) => Body::from(replacer.replace_all(bytes)),
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
            _ => Body::from_stream(NonceBodyStream {
                inner: body.into_data_stream(),
                replacer,
                done: false,
            }),
        };
        Response::from_parts(parts, body)
    }
}

/// Insert a default unless the response set the header itself; a response
/// value that is empty means "not on this response" and removes it.
fn stamp_default(
    headers: &mut HeaderMap,
    name: &HeaderName,
    value: impl FnOnce() -> Option<HeaderValue>,
) {
    match headers.get(name) {
        Some(existing) if existing.is_empty() => {
            headers.remove(name);
        }
        Some(_) => {}
        None => {
            if let Some(value) = value() {
                headers.insert(name.clone(), value);
            }
        }
    }
}

/// A page can put `cspNonce()` into its own headers (a CSP it builds, a
/// Link preload): those carry the response's nonce too.
fn substitute_header_values(headers: &mut HeaderMap, placeholder: &Bytes, nonce: &mut LazyNonce) {
    let affected: Vec<HeaderName> = headers
        .iter()
        .filter(|(_, value)| find(value.as_bytes(), placeholder).is_some())
        .map(|(name, _)| name.clone())
        .collect();
    if affected.is_empty() {
        return;
    }
    let replacer = NonceReplacer::new(placeholder.clone(), Bytes::from(nonce.get().to_string()));
    for name in affected {
        let values: Vec<HeaderValue> = headers
            .get_all(&name)
            .iter()
            .filter_map(|value| {
                let replaced = replacer.replace_all(Bytes::copy_from_slice(value.as_bytes()));
                HeaderValue::from_bytes(&replaced).ok()
            })
            .collect();
        headers.remove(&name);
        for value in values {
            headers.append(name.clone(), value);
        }
    }
}

/// Bodies that may carry the placeholder: worker output in a text format.
/// public/ and build assets (`x-gio-cache: static`) never do - and must
/// keep their exact bytes, lengths and range support.
fn substitutes_body(headers: &HeaderMap) -> bool {
    if headers
        .get("x-gio-cache")
        .is_some_and(|value| value.as_bytes() == b"static")
        || headers.contains_key(header::CONTENT_ENCODING)
    {
        return false;
    }
    let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        mime.as_str(),
        "text/html"
            | "text/plain"
            | "text/event-stream"
            | "application/json"
            | "application/xhtml+xml"
    ) || mime.ends_with("+json")
}

/// The Strict-Transport-Security value, or None. Unset means "only when this
/// server terminates TLS": over plain HTTP the header is either ignored
/// (direct) or a promise only the operator can make (TLS proxy), so sending
/// it there is opt-in.
fn hsts_value(setting: Option<&HstsSetting>, tls_enabled: bool) -> Option<String> {
    let default = || format!("max-age={}", default_hsts_max_age());
    match setting {
        None => tls_enabled.then(default),
        Some(HstsSetting::Enabled(enabled)) => enabled.then(default),
        Some(HstsSetting::Raw(raw)) => {
            let raw = raw.trim();
            (!raw.is_empty()).then(|| raw.to_string())
        }
        Some(HstsSetting::Policy(policy)) => {
            let mut value = format!("max-age={}", policy.max_age);
            if policy.include_subdomains {
                value.push_str("; includeSubDomains");
            }
            if policy.preload {
                value.push_str("; preload");
            }
            Some(value)
        }
    }
}

/// Outermost content layer (inside compression, outside everything else):
/// sees every response the router produced, before it is compressed.
pub async fn security_headers_middleware(
    State(policy): State<Arc<SecurityPolicy>>,
    req: Request,
    next: Next,
) -> Response {
    let resp = next.run(req).await;
    policy.secure_response(resp).await
}

// ── Cross-site request protection ─────────────────────────────────────────────

/// Methods that change state and so must not be forgeable cross-site:
/// everything but the safe methods (custom methods included).
pub fn is_unsafe_method(method: &Method) -> bool {
    !matches!(
        *method,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE
    )
}

/// The authority (`host[:port]`) the client addressed - what a same-origin
/// request's Origin names. The Host header, or the HTTP/2 :authority.
///
/// MERGE NOTE (client-identity workstream): this is the single place the
/// cross-site checks learn the request's own host. Behind a trusted proxy
/// that rewrites Host, return the X-Forwarded-Host it supplied here (for
/// trusted peers only) - CSRF and the WebSocket origin check both follow.
pub fn expected_origin_authority(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            uri.authority()
                .map(|authority| authority.as_str().to_string())
        })
}

/// A parsed `http(s)://host[:port]` origin, port defaulted from the scheme.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Origin {
    https: bool,
    host: String,
    port: u16,
}

impl Origin {
    fn parse(raw: &str) -> Option<Self> {
        let (scheme, rest) = raw.trim().split_once("://")?;
        let https = if scheme.eq_ignore_ascii_case("https") {
            true
        } else if scheme.eq_ignore_ascii_case("http") {
            false
        } else {
            return None;
        };
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        if authority.contains(['/', '?', '#', '@']) {
            return None;
        }
        let (host, port) = split_authority(authority)?;
        Some(Origin {
            https,
            host,
            port: port.unwrap_or(if https { 443 } else { 80 }),
        })
    }

    /// Same host and port as `authority` (a Host header, which carries no
    /// scheme: a port it omits is this origin's default).
    fn matches_authority(&self, authority: &str) -> bool {
        let default_port = if self.https { 443 } else { 80 };
        split_authority(authority).is_some_and(|(host, port)| {
            host == self.host && port.unwrap_or(default_port) == self.port
        })
    }
}

/// `Example.COM:8080` -> (`example.com`, Some(8080)); `[::1]` -> (`[::1]`,
/// None). A trailing dot is the same FQDN. None for anything not a host.
fn split_authority(raw: &str) -> Option<(String, Option<u16>)> {
    let raw = raw.trim();
    let (host, port) = if raw.starts_with('[') {
        let end = raw.find(']')?;
        let port = match &raw[end + 1..] {
            "" => None,
            after => Some(after.strip_prefix(':')?),
        };
        (&raw[..=end], port)
    } else {
        match raw.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (raw, None),
        }
    };
    let port = match port {
        Some(port) => Some(port.parse::<u16>().ok()?),
        None => None,
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let bracketed = host.starts_with('[');
    if host.is_empty()
        || host.contains(['/', '@', ' ', '\\', '*'])
        || (!bracketed && host.contains(':'))
    {
        return None;
    }
    Some((host, port))
}

/// Why a cross-site request was refused.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CrossSiteRejection {
    /// The browser reported `Sec-Fetch-Site: cross-site` or `same-site`.
    FetchSite {
        site: String,
        origin: Option<String>,
    },
    /// No Sec-Fetch-Site, and Origin names another host than the request's.
    ForeignOrigin { origin: String },
}

impl CrossSiteRejection {
    pub fn origin(&self) -> Option<&str> {
        match self {
            Self::FetchSite { origin, .. } => origin.as_deref(),
            Self::ForeignOrigin { origin } => Some(origin),
        }
    }

    /// Plain-text 403 body naming the gio.toml keys that change the verdict.
    pub fn message(&self, what: &str) -> String {
        let reason = match self {
            Self::FetchSite {
                site,
                origin: Some(origin),
            } => format!("the browser sent it from {origin} ({site})"),
            Self::FetchSite { site, origin: None } => {
                format!("the browser sent it from another site ({site})")
            }
            Self::ForeignOrigin { origin } => format!("its Origin {origin} is not this site"),
        };
        format!(
            "403 Forbidden: cross-site {what} blocked by CSRF protection - {reason}.\n\
             If that origin is yours, add it to [security.csrf] trusted_origins in gio.toml; \
             to accept cross-site requests on a path (webhooks), add the path to \
             [security.csrf] exempt.\n"
        )
    }
}

/// `[security.csrf]`, compiled.
#[derive(Debug)]
pub struct CsrfPolicy {
    enabled: bool,
    trusted_origins: Vec<Origin>,
    exempt: Vec<PathPattern>,
    /// Hashes of the origins already reported at warn level.
    warned: Mutex<HashSet<u64>>,
}

impl CsrfPolicy {
    fn new(cfg: &crate::config::CsrfConfig) -> Result<Self, SecurityConfigError> {
        let trusted_origins = cfg
            .trusted_origins
            .iter()
            .map(|raw| {
                Origin::parse(raw)
                    .ok_or_else(|| SecurityConfigError::InvalidTrustedOrigin(raw.clone()))
            })
            .collect::<Result<_, _>>()?;
        let exempt = cfg
            .exempt
            .iter()
            .map(|raw| {
                PathPattern::compile(raw)
                    .map_err(|e| SecurityConfigError::InvalidExempt(raw.clone(), e))
            })
            .collect::<Result<_, _>>()?;
        Ok(CsrfPolicy {
            enabled: cfg.enabled,
            trusted_origins,
            exempt,
            warned: Mutex::default(),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn trusted_origin_count(&self) -> usize {
        self.trusted_origins.len()
    }

    pub fn exempt_count(&self) -> usize {
        self.exempt.len()
    }

    /// Whether the canonical request path is listed in `exempt`.
    pub fn is_exempt(&self, canonical_path: &str) -> bool {
        self.exempt
            .iter()
            .any(|pattern| pattern.matches(canonical_path))
    }

    fn is_trusted(&self, origin: &str) -> bool {
        Origin::parse(origin).is_some_and(|origin| self.trusted_origins.contains(&origin))
    }

    /// The decision for one unsafe request or WebSocket upgrade. `authority`
    /// is `expected_origin_authority`; the other two are the raw headers.
    pub fn check(
        &self,
        sec_fetch_site: Option<&str>,
        origin: Option<&str>,
        authority: Option<&str>,
    ) -> Result<(), CrossSiteRejection> {
        let origin = origin.map(str::trim).filter(|origin| !origin.is_empty());
        if origin.is_some_and(|origin| self.is_trusted(origin)) {
            return Ok(());
        }
        if let Some(site) = sec_fetch_site.map(|site| site.trim().to_ascii_lowercase()) {
            match site.as_str() {
                // `none`: the address bar or a bookmark - the user's own act.
                "same-origin" | "none" => return Ok(()),
                // same-site too: a sibling subdomain can be attacker-controlled.
                "same-site" | "cross-site" => {
                    return Err(CrossSiteRejection::FetchSite {
                        site,
                        origin: origin.map(str::to_string),
                    })
                }
                // A value from a future spec: decide on Origin instead.
                _ => {}
            }
        }
        let Some(origin) = origin else {
            // Neither header: not sent by a browser page, so not forgeable
            // by one (curl, webhooks, server-to-server calls).
            return Ok(());
        };
        let same_origin = Origin::parse(origin)
            .zip(authority)
            .is_some_and(|(parsed, authority)| parsed.matches_authority(authority));
        if same_origin {
            Ok(())
        } else {
            Err(CrossSiteRejection::ForeignOrigin {
                origin: origin.to_string(),
            })
        }
    }

    /// Whether a rejection deserves a warn-level line: once per distinct
    /// origin (up to MAX_WARNED_ORIGINS), debug level after that.
    pub fn should_warn(&self, rejection: &CrossSiteRejection) -> bool {
        let mut hasher = DefaultHasher::new();
        rejection.origin().unwrap_or("").hash(&mut hasher);
        let mut warned = self.warned.lock().unwrap_or_else(PoisonError::into_inner);
        warned.len() < MAX_WARNED_ORIGINS && warned.insert(hasher.finish())
    }
}

/// The 403 for a refused cross-site request; `what` names it ("POST",
/// "WebSocket upgrade").
pub fn cross_site_rejection_response(rejection: &CrossSiteRejection, what: &str) -> Response {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-gio-cache", "bypass")
        .body(Body::from(rejection.message(what)))
        .unwrap_or_else(|_| StatusCode::FORBIDDEN.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CsrfConfig, HstsPolicy};

    const PLACEHOLDER: &str = "0123456789abcdef0123456789abcdef";
    const NONCE_CSP: &str =
        "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'";

    fn policy(cfg: SecurityConfig) -> SecurityPolicy {
        SecurityPolicy::new(&cfg, false).unwrap()
    }

    fn nonce_policy() -> SecurityPolicy {
        policy(SecurityConfig {
            csp: Some(NONCE_CSP.to_string()),
            ..Default::default()
        })
        .with_nonce_placeholder(PLACEHOLDER)
    }

    fn html_response(body: impl Into<Body>) -> Response {
        Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header("x-gio-cache", "miss; stored")
            .body(body.into())
            .unwrap()
    }

    async fn body_text(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn header_str<'a>(resp: &'a Response, name: &str) -> Option<&'a str> {
        resp.headers()
            .get(name)
            .map(|value| value.to_str().unwrap())
    }

    /// The nonce a CSP header value carries.
    fn csp_nonce(csp: &str) -> String {
        let start = csp.find("'nonce-").expect("nonce source") + "'nonce-".len();
        let end = start + csp[start..].find('\'').unwrap();
        csp[start..end].to_string()
    }

    // ── default headers ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn defaults_are_stamped_and_x_powered_by_stripped() {
        let mut resp = html_response("<p>x</p>");
        resp.headers_mut()
            .insert("x-powered-by", HeaderValue::from_static("Express"));
        let resp = policy(SecurityConfig::default())
            .secure_response(resp)
            .await;
        assert_eq!(header_str(&resp, "x-content-type-options"), Some("nosniff"));
        assert_eq!(header_str(&resp, "x-frame-options"), Some("SAMEORIGIN"));
        assert_eq!(
            header_str(&resp, "referrer-policy"),
            Some("strict-origin-when-cross-origin")
        );
        assert_eq!(header_str(&resp, "x-powered-by"), None);
        assert_eq!(header_str(&resp, "strict-transport-security"), None);
        assert_eq!(header_str(&resp, "content-security-policy"), None);
        assert_eq!(header_str(&resp, "permissions-policy"), None);
        assert_eq!(header_str(&resp, "cross-origin-opener-policy"), None);
    }

    #[tokio::test]
    async fn response_headers_win_and_an_empty_value_removes_the_default() {
        let mut resp = html_response("x");
        resp.headers_mut()
            .insert("x-frame-options", HeaderValue::from_static("DENY"));
        resp.headers_mut()
            .insert("referrer-policy", HeaderValue::from_static(""));
        resp.headers_mut().insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'"),
        );
        let resp = nonce_policy().secure_response(resp).await;
        assert_eq!(header_str(&resp, "x-frame-options"), Some("DENY"));
        assert_eq!(header_str(&resp, "referrer-policy"), None);
        assert_eq!(
            header_str(&resp, "content-security-policy"),
            Some("default-src 'none'"),
            "a CSP the app set itself is kept"
        );
    }

    #[test]
    fn hsts_only_over_tls_unless_configured() {
        let names = |cfg: &SecurityConfig, tls| {
            SecurityPolicy::new(cfg, tls)
                .unwrap()
                .defaults
                .iter()
                .find(|(name, _)| *name == header::STRICT_TRANSPORT_SECURITY)
                .map(|(_, value)| value.to_str().unwrap().to_string())
        };
        let unset = SecurityConfig::default();
        assert_eq!(names(&unset, false), None, "never on plain HTTP by default");
        assert_eq!(names(&unset, true).as_deref(), Some("max-age=31536000"));

        let with = |hsts| SecurityConfig {
            hsts: Some(hsts),
            ..Default::default()
        };
        assert_eq!(names(&with(HstsSetting::Enabled(false)), true), None);
        assert_eq!(
            names(&with(HstsSetting::Enabled(true)), false).as_deref(),
            Some("max-age=31536000"),
            "explicitly forced behind a TLS-terminating proxy"
        );
        assert_eq!(names(&with(HstsSetting::Raw(String::new())), true), None);
        assert_eq!(
            names(&with(HstsSetting::Raw("max-age=60".into())), false).as_deref(),
            Some("max-age=60")
        );
        let table = HstsSetting::Policy(HstsPolicy {
            max_age: 63_072_000,
            include_subdomains: true,
            preload: true,
        });
        assert_eq!(
            names(&with(table), false).as_deref(),
            Some("max-age=63072000; includeSubDomains; preload")
        );
    }

    #[tokio::test]
    async fn security_headers_table_overrides_disables_and_adds() {
        let mut cfg = SecurityConfig::default();
        cfg.headers.insert("X-Frame-Options".into(), "DENY".into());
        cfg.headers.insert("referrer-policy".into(), "".into());
        cfg.headers
            .insert("permissions-policy".into(), "camera=()".into());
        cfg.headers
            .insert("cross-origin-opener-policy".into(), "same-origin".into());
        let resp = policy(cfg).secure_response(html_response("x")).await;
        assert_eq!(header_str(&resp, "x-frame-options"), Some("DENY"));
        assert_eq!(header_str(&resp, "referrer-policy"), None);
        assert_eq!(header_str(&resp, "permissions-policy"), Some("camera=()"));
        assert_eq!(
            header_str(&resp, "cross-origin-opener-policy"),
            Some("same-origin")
        );
        assert_eq!(header_str(&resp, "x-content-type-options"), Some("nosniff"));
    }

    #[test]
    fn invalid_security_config_is_a_startup_error() {
        let with_header = |name: &str, value: &str| {
            let mut cfg = SecurityConfig::default();
            cfg.headers.insert(name.into(), value.into());
            SecurityPolicy::new(&cfg, false)
        };
        assert!(matches!(
            with_header("bad name", "x"),
            Err(SecurityConfigError::InvalidHeaderName(_))
        ));
        assert!(matches!(
            with_header("x-a", "line\nbreak"),
            Err(SecurityConfigError::InvalidHeaderValue(_))
        ));
        for reserved in [
            "content-security-policy",
            "Content-Security-Policy-Report-Only",
            "strict-transport-security",
        ] {
            assert!(matches!(
                with_header(reserved, "x"),
                Err(SecurityConfigError::ReservedHeader(..))
            ));
        }
        let csp = SecurityConfig {
            csp: Some("default-src 'self'\u{7}".into()),
            ..Default::default()
        };
        assert!(matches!(
            SecurityPolicy::new(&csp, false),
            Err(SecurityConfigError::InvalidPolicy("csp"))
        ));
        let csrf = |cfg: CsrfConfig| SecurityConfig {
            csrf: cfg,
            ..Default::default()
        };
        for origin in [
            "admin.example.com",
            "https://a.example/path",
            "ftp://a.example",
            "*",
        ] {
            let cfg = csrf(CsrfConfig {
                trusted_origins: vec![origin.into()],
                ..Default::default()
            });
            assert!(
                matches!(
                    SecurityPolicy::new(&cfg, false),
                    Err(SecurityConfigError::InvalidTrustedOrigin(_))
                ),
                "{origin}"
            );
        }
        let cfg = csrf(CsrfConfig {
            exempt: vec!["api/webhooks".into()],
            ..Default::default()
        });
        assert!(matches!(
            SecurityPolicy::new(&cfg, false),
            Err(SecurityConfigError::InvalidExempt(..))
        ));
    }

    // ── CSP and nonces ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn csp_without_nonce_is_sent_verbatim_and_multiline_policies_collapse() {
        let policy = policy(SecurityConfig {
            csp: Some("default-src 'self';\n    img-src *".into()),
            csp_report_only: Some("default-src 'none'".into()),
            ..Default::default()
        });
        assert!(!policy.uses_nonces());
        let resp = policy.secure_response(html_response("x")).await;
        assert_eq!(
            header_str(&resp, "content-security-policy"),
            Some("default-src 'self'; img-src *")
        );
        assert_eq!(
            header_str(&resp, "content-security-policy-report-only"),
            Some("default-src 'none'")
        );
    }

    #[tokio::test]
    async fn every_framework_nonce_in_the_body_equals_the_header_nonce() {
        let policy = SecurityPolicy::new(
            &SecurityConfig {
                csp: Some(NONCE_CSP.into()),
                csp_report_only: Some("script-src 'nonce-{nonce}'".into()),
                ..Default::default()
            },
            false,
        )
        .unwrap()
        .with_nonce_placeholder(PLACEHOLDER);
        assert!(policy.uses_nonces());
        let body = format!(
            "<html><head><script nonce=\"{PLACEHOLDER}\">a</script></head>\
             <body><script nonce=\"{PLACEHOLDER}\" type=\"module\" src=\"/x.js\"></script></body></html>"
        );
        let mut resp = html_response(body);
        resp.headers_mut()
            .insert(header::CONTENT_LENGTH, HeaderValue::from_static("999"));
        let resp = policy.secure_response(resp).await;
        let csp = header_str(&resp, "content-security-policy")
            .unwrap()
            .to_string();
        let nonce = csp_nonce(&csp);
        assert_eq!(nonce.len(), 24, "144 bits, base64");
        assert_eq!(
            csp_nonce(header_str(&resp, "content-security-policy-report-only").unwrap()),
            nonce,
            "one nonce per response"
        );
        assert_eq!(
            header_str(&resp, "content-length"),
            None,
            "stale length dropped"
        );
        let html = body_text(resp).await;
        assert!(
            !html.contains(PLACEHOLDER),
            "placeholder never reaches the client"
        );
        assert_eq!(html.matches(&format!("nonce=\"{nonce}\"")).count(), 2);
    }

    #[tokio::test]
    async fn each_serve_of_the_same_cached_bytes_gets_a_fresh_nonce() {
        let policy = nonce_policy();
        let cached = Bytes::from(format!("<script nonce=\"{PLACEHOLDER}\">x</script>"));
        let mut nonces = HashSet::new();
        for _ in 0..3 {
            let resp = policy.secure_response(html_response(cached.clone())).await;
            let nonce = csp_nonce(header_str(&resp, "content-security-policy").unwrap());
            assert_eq!(
                body_text(resp).await,
                format!("<script nonce=\"{nonce}\">x</script>")
            );
            nonces.insert(nonce);
        }
        assert_eq!(nonces.len(), 3);
    }

    #[tokio::test]
    async fn streamed_bodies_are_substituted_across_chunk_boundaries() {
        let policy = nonce_policy();
        let doc = format!(
            "<html><head><script nonce=\"{PLACEHOLDER}\">s</script></head><body>shell\
             <script nonce=\"{PLACEHOLDER}\">$RC(\"B:0\")</script>{PLACEHOLDER}</body></html>"
        );
        // Every split point, including inside each placeholder.
        for split in 0..=doc.len() {
            let (a, b) = doc.split_at(split);
            let chunks: Vec<Result<Bytes, std::convert::Infallible>> = vec![
                Ok(Bytes::copy_from_slice(a.as_bytes())),
                Ok(Bytes::copy_from_slice(b.as_bytes())),
            ];
            let resp = html_response(Body::from_stream(tokio_stream::iter(chunks)));
            let resp = policy.secure_response(resp).await;
            let nonce = csp_nonce(header_str(&resp, "content-security-policy").unwrap());
            assert_eq!(
                body_text(resp).await,
                doc.replace(PLACEHOLDER, &nonce),
                "split at {split}"
            );
        }
    }

    #[tokio::test]
    async fn ppr_shell_and_hole_chunks_share_the_response_nonce() {
        // A PPR hit: the cached shell, then hole chunks from a second render
        // (byte-at-a-time to stress the boundary handling).
        let policy = nonce_policy();
        let shell = format!("<html><head><script nonce=\"{PLACEHOLDER}\">d</script></head><body>");
        let hole = format!("<script nonce=\"{PLACEHOLDER}\">$RC()</script></body></html>");
        let mut chunks: Vec<Result<Bytes, std::convert::Infallible>> =
            vec![Ok(Bytes::from(shell.clone()))];
        chunks.extend(hole.bytes().map(|b| Ok(Bytes::from(vec![b]))));
        let resp = html_response(Body::from_stream(tokio_stream::iter(chunks)));
        let resp = policy.secure_response(resp).await;
        let nonce = csp_nonce(header_str(&resp, "content-security-policy").unwrap());
        let html = body_text(resp).await;
        assert_eq!(html, format!("{shell}{hole}").replace(PLACEHOLDER, &nonce));
    }

    #[tokio::test]
    async fn guessed_placeholders_are_never_promoted_to_the_nonce() {
        // Stored XSS: the attacker can write markup but cannot know the
        // per-installation placeholder, nor use the config's `{nonce}` slot.
        let policy = nonce_policy();
        let injected = "<script nonce=\"{nonce}\">evil()</script>\
                        <script nonce=\"00000000000000000000000000000000\">evil()</script>\
                        <script nonce=\"0123456789abcdef0123456789abcdee\">evil()</script>";
        let resp = policy.secure_response(html_response(injected)).await;
        let nonce = csp_nonce(header_str(&resp, "content-security-policy").unwrap());
        let html = body_text(resp).await;
        assert_eq!(html, injected);
        assert!(!html.contains(&nonce));
    }

    #[tokio::test]
    async fn static_and_binary_bodies_are_left_untouched() {
        let policy = nonce_policy();
        let body = format!("<script nonce=\"{PLACEHOLDER}\">");
        let mut static_file = html_response(body.clone());
        static_file
            .headers_mut()
            .insert("x-gio-cache", HeaderValue::from_static("static"));
        assert_eq!(
            body_text(policy.secure_response(static_file).await).await,
            body
        );

        let image = Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .body(Body::from(body.clone()))
            .unwrap();
        assert_eq!(body_text(policy.secure_response(image).await).await, body);
    }

    #[tokio::test]
    async fn route_handler_text_and_headers_never_leak_the_placeholder() {
        let policy = nonce_policy();
        let resp = Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .header("link", format!("</a.js>; rel=preload; nonce={PLACEHOLDER}"))
            .body(Body::from(format!("{{\"nonce\":\"{PLACEHOLDER}\"}}")))
            .unwrap();
        let resp = policy.secure_response(resp).await;
        let nonce = csp_nonce(header_str(&resp, "content-security-policy").unwrap());
        assert_eq!(
            header_str(&resp, "link").unwrap(),
            format!("</a.js>; rel=preload; nonce={nonce}")
        );
        assert_eq!(body_text(resp).await, format!("{{\"nonce\":\"{nonce}\"}}"));
    }

    #[tokio::test]
    async fn without_nonces_bodies_pass_through_with_their_length() {
        let policy = policy(SecurityConfig {
            csp: Some("default-src 'self'".into()),
            ..Default::default()
        });
        let resp = policy.secure_response(html_response("<p>hi</p>")).await;
        assert_eq!(resp.body().size_hint().exact(), Some(9));
    }

    #[test]
    fn nonces_are_unique_base64() {
        let nonces: HashSet<String> = (0..100).map(|_| generate_nonce()).collect();
        assert_eq!(nonces.len(), 100);
        for nonce in &nonces {
            assert_eq!(nonce.len(), 24);
            assert!(nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/'));
        }
    }

    #[test]
    fn replacer_holds_back_only_possible_placeholder_starts() {
        let mut replacer =
            NonceReplacer::new(Bytes::from_static(b"abcd"), Bytes::from_static(b"N"));
        assert_eq!(
            replacer.feed(Bytes::from_static(b"xxab")),
            Some(Bytes::from_static(b"xx"))
        );
        assert_eq!(replacer.feed(Bytes::from_static(b"c")), None);
        assert_eq!(
            replacer.feed(Bytes::from_static(b"dyy")),
            Some(Bytes::from_static(b"Nyy"))
        );
        assert_eq!(replacer.feed(Bytes::from_static(b"ab")), None);
        assert_eq!(replacer.finish(), Some(Bytes::from_static(b"ab")));
        assert_eq!(
            replacer.feed(Bytes::from_static(b"plain")),
            Some(Bytes::from_static(b"plain"))
        );
        assert_eq!(
            replacer.replace_all(Bytes::from_static(b"abcdabcabcd")),
            Bytes::from_static(b"NabcN")
        );
    }

    #[test]
    fn cache_epoch_fingerprints_the_placeholder() {
        assert_eq!(cache_epoch("dep", None), "dep");
        let a = cache_epoch("dep", Some(PLACEHOLDER));
        assert!(a.starts_with("dep+csp-"));
        assert!(
            !a.contains(PLACEHOLDER),
            "the epoch is stored on disk, not the secret"
        );
        assert_ne!(
            a,
            cache_epoch("dep", Some("ffffffffffffffffffffffffffffffff"))
        );
        assert_eq!(a, cache_epoch("dep", Some(PLACEHOLDER)));
    }

    #[test]
    fn placeholder_persists_and_corrupt_files_are_replaced() {
        let dir = std::env::temp_dir().join(format!(
            "gio_security_test_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let first = load_or_create_nonce_placeholder(&dir);
        assert!(is_valid_placeholder(&first));
        assert_eq!(
            load_or_create_nonce_placeholder(&dir),
            first,
            "survives restarts"
        );
        std::fs::write(dir.join(PLACEHOLDER_FILE), "short").unwrap();
        let replaced = load_or_create_nonce_placeholder(&dir);
        assert!(is_valid_placeholder(&replaced));
        assert_eq!(load_or_create_nonce_placeholder(&dir), replaced);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(PLACEHOLDER_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(PLACEHOLDER_FILE)]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(generate_placeholder(), generate_placeholder());
    }

    #[test]
    fn nonce_attr_splices_into_the_opening_tag() {
        assert_eq!(
            with_nonce_attr("<script id=\"x\">a</script>", "<script", " nonce=\"P\""),
            "<script nonce=\"P\" id=\"x\">a</script>"
        );
        assert_eq!(
            with_nonce_attr("<script>a</script>", "<script", ""),
            "<script>a</script>"
        );
        assert_eq!(
            nonce_attr_for(PLACEHOLDER),
            format!(" nonce=\"{PLACEHOLDER}\"")
        );
    }

    // ── cross-site request protection ────────────────────────────────────────

    fn csrf(trusted: &[&str], exempt: &[&str]) -> CsrfPolicy {
        CsrfPolicy::new(&CsrfConfig {
            enabled: true,
            trusted_origins: trusted.iter().map(|s| s.to_string()).collect(),
            exempt: exempt.iter().map(|s| s.to_string()).collect(),
        })
        .unwrap()
    }

    #[test]
    fn csrf_decision_table() {
        let p = csrf(&["https://admin.example.com"], &[]);
        let host = Some("example.com");
        let ok = |site, origin| p.check(site, origin, host).is_ok();

        // Sec-Fetch-Site decides when present.
        assert!(ok(Some("same-origin"), Some("https://example.com")));
        assert!(ok(Some("same-origin"), None));
        assert!(ok(Some("none"), None));
        assert!(!ok(Some("cross-site"), Some("https://evil.example")));
        assert!(!ok(Some("cross-site"), None));
        assert!(
            !ok(Some("same-site"), Some("https://blog.example.com")),
            "sibling subdomains"
        );
        assert!(!ok(Some("Cross-Site"), None), "case-insensitive");
        // A trusted origin passes even cross-site / same-site.
        assert!(ok(Some("same-site"), Some("https://admin.example.com")));
        assert!(ok(
            Some("cross-site"),
            Some("https://ADMIN.example.com:443/")
        ));
        assert!(
            !ok(Some("cross-site"), Some("http://admin.example.com")),
            "scheme matters"
        );

        // No Sec-Fetch-Site: Origin must name this host.
        assert!(ok(None, Some("https://example.com")));
        assert!(ok(None, Some("http://example.com")));
        assert!(!ok(None, Some("https://evil.example")));
        assert!(!ok(None, Some("https://example.com.evil.example")));
        assert!(!ok(None, Some("null")), "opaque origins never match");
        assert!(!ok(None, Some("<invalid>")));
        assert!(ok(None, Some("https://admin.example.com")));
        // Unknown Sec-Fetch-Site values fall back to Origin.
        assert!(ok(Some("future-value"), Some("https://example.com")));
        assert!(!ok(Some("future-value"), Some("https://evil.example")));

        // Neither header: curl, webhooks, server-to-server.
        assert!(ok(None, None));
        assert!(ok(None, Some("  ")));

        // Origin without a Host to compare with cannot be same-origin.
        assert!(p.check(None, Some("https://example.com"), None).is_err());
    }

    #[test]
    fn origin_matching_normalizes_ports_case_and_ipv6() {
        let p = csrf(&[], &[]);
        let ok = |origin, host| p.check(None, Some(origin), Some(host)).is_ok();
        assert!(ok("http://localhost:3000", "localhost:3000"));
        assert!(!ok("http://localhost:3001", "localhost:3000"));
        assert!(ok("https://Example.COM", "example.com:443"));
        assert!(ok("http://example.com", "example.com:80"));
        assert!(!ok("https://example.com", "example.com:80"));
        assert!(ok("https://example.com", "EXAMPLE.com."));
        assert!(ok("http://[::1]:3000", "[::1]:3000"));
        assert!(!ok("http://[::1]:3000", "[::2]:3000"));
        assert!(!ok("http://user@example.com", "example.com"));
        assert!(!ok("http://example.com/path", "example.com"));
    }

    #[test]
    fn exempt_paths_use_rule_patterns() {
        let p = csrf(&[], &["/api/webhooks/*rest", "/hooks/:id"]);
        assert!(p.is_exempt("/api/webhooks/stripe"));
        assert!(p.is_exempt("/api/webhooks"));
        assert!(p.is_exempt("/hooks/42"));
        assert!(!p.is_exempt("/hooks/42/x"));
        assert!(!p.is_exempt("/api/notes"));
    }

    #[test]
    fn rejections_are_logged_once_per_origin() {
        let p = csrf(&[], &[]);
        let evil = p
            .check(None, Some("https://evil.example"), Some("a"))
            .unwrap_err();
        assert!(p.should_warn(&evil));
        assert!(!p.should_warn(&evil));
        let other = p
            .check(Some("cross-site"), Some("https://other.example"), Some("a"))
            .unwrap_err();
        assert!(p.should_warn(&other));
        assert!(evil
            .message("POST")
            .contains("[security.csrf] trusted_origins"));
        assert!(evil.message("POST").contains("[security.csrf] exempt"));
    }

    #[test]
    fn unsafe_methods_are_everything_but_the_safe_ones() {
        for method in [
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::CONNECT,
        ] {
            assert!(is_unsafe_method(&method), "{method}");
        }
        assert!(is_unsafe_method(&Method::from_bytes(b"PURGE").unwrap()));
        for method in [Method::GET, Method::HEAD, Method::OPTIONS, Method::TRACE] {
            assert!(!is_unsafe_method(&method), "{method}");
        }
    }

    #[test]
    fn expected_authority_prefers_host_then_uri_authority() {
        let mut headers = HeaderMap::new();
        let uri: Uri = "https://h2.example:8443/x".parse().unwrap();
        assert_eq!(
            expected_origin_authority(&headers, &uri).as_deref(),
            Some("h2.example:8443")
        );
        headers.insert(header::HOST, HeaderValue::from_static("site.example"));
        assert_eq!(
            expected_origin_authority(&headers, &uri).as_deref(),
            Some("site.example")
        );
    }
}
