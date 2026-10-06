//! giojs-server/src/client_identity.rs
//!
//! Who sent a request, as seen through trusted reverse proxies, and the
//! request id that follows it through both logs.
//!
//! The peer socket address is the only thing a client cannot forge. Behind a
//! proxy it is the proxy, so the real client lives in a forwarding header -
//! which any client can also send. `[server] trusted_proxies` names the peers
//! whose forwarding headers count; from everyone else they are ignored
//! entirely. With the default (empty) list nothing is trusted and the peer
//! address is the client, exactly as without a proxy.
//!
//! The client IP walks the forwarding chain right to left: every hop a
//! trusted proxy appended is skipped, and the first address no trusted proxy
//! vouches for is the client. Entries left of it were written by the client
//! itself and are never read, so a spoofed `X-Forwarded-For: 1.2.3.4` sent
//! through nginx's `$proxy_add_x_forwarded_for` changes nothing.
//!
//! Exactly one header family is honored (`[server] proxy_headers`): the
//! `X-Forwarded-For/-Proto/-Host` trio (default) or RFC 7239 `Forwarded`.
//! Honoring both would let a client supply whichever one the proxy does not
//! manage - nginx appends to X-Forwarded-For but passes a client's own
//! `Forwarded` header through untouched.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

use axum::http::{header, HeaderMap};
use serde::Deserialize;

/// Request header carrying the request id (and the response header echoing it).
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Longest incoming request id accepted from a trusted proxy.
const MAX_REQUEST_ID_LEN: usize = 128;

/// Longest forwarding header value parsed; anything longer is malformed.
/// Real chains are a handful of hops, and the walk is per request.
const MAX_FORWARDED_LEN: usize = 8 * 1024;

/// One `trusted_proxies` entry: a single address or a CIDR block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpNet {
    network: IpAddr,
    prefix: u8,
}

impl IpNet {
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.network, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                mask_v4(u32::from(ip), self.prefix) == u32::from(net)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                mask_v6(u128::from(ip), self.prefix) == u128::from(net)
            }
            _ => false,
        }
    }
}

/// Keep the top `prefix` bits (`prefix` <= 32; a /0 keeps none).
fn mask_v4(bits: u32, prefix: u8) -> u32 {
    match prefix {
        0 => 0,
        p => bits & (u32::MAX << (32 - u32::from(p))),
    }
}

/// Keep the top `prefix` bits (`prefix` <= 128; a /0 keeps none).
fn mask_v6(bits: u128, prefix: u8) -> u128 {
    match prefix {
        0 => 0,
        p => bits & (u128::MAX << (128 - u32::from(p))),
    }
}

impl FromStr for IpNet {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let invalid = || {
            format!(
                "invalid trusted_proxies entry {raw:?}: expected an IP address or CIDR block \
                 such as \"10.0.0.1\", \"10.0.0.0/8\" or \"fd00::/8\""
            )
        };
        let (addr, prefix) = match raw.trim().split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix)),
            None => (raw.trim(), None),
        };
        // An IPv4-mapped IPv6 entry means the IPv4 address it maps.
        let addr = addr
            .parse::<IpAddr>()
            .map_err(|_| invalid())?
            .to_canonical();
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => max,
            Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => p
                .parse::<u8>()
                .ok()
                .filter(|p| *p <= max)
                .ok_or_else(invalid)?,
            Some(_) => return Err(invalid()),
        };
        // Host bits are masked off, so "10.1.2.3/8" means 10.0.0.0/8.
        let network = match addr {
            IpAddr::V4(v4) => IpAddr::V4(mask_v4(u32::from(v4), prefix).into()),
            IpAddr::V6(v6) => IpAddr::V6(mask_v6(u128::from(v6), prefix).into()),
        };
        Ok(Self { network, prefix })
    }
}

impl fmt::Display for IpNet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

/// `[server] trusted_proxies`, parsed at load time: a malformed entry is a
/// configuration error, never a silently shorter list.
#[derive(Debug, Clone, Default)]
pub struct TrustedProxies(Vec<IpNet>);

impl TrustedProxies {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        self.0.iter().any(|net| net.contains(ip))
    }

    pub fn entries(&self) -> &[IpNet] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TrustedProxies {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Vec::<String>::deserialize(deserializer)?;
        raw.iter()
            .map(|entry| entry.parse::<IpNet>())
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

/// `[server] proxy_headers`: which forwarding header family a trusted proxy
/// speaks. Only that family is read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub enum ProxyHeaders {
    /// `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`.
    #[default]
    #[serde(rename = "x-forwarded")]
    XForwarded,
    /// RFC 7239 `Forwarded: for=...;proto=...;host=...`.
    #[serde(rename = "forwarded")]
    Forwarded,
}

impl ProxyHeaders {
    /// The gio.toml spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::XForwarded => "x-forwarded",
            Self::Forwarded => "forwarded",
        }
    }
}

/// Everything `resolve` needs besides the request itself; built once at
/// startup.
#[derive(Debug, Clone, Default)]
pub struct ProxyTrust {
    pub trusted: TrustedProxies,
    pub headers: ProxyHeaders,
    /// The listener terminates TLS itself, so direct requests are https.
    pub tls: bool,
}

/// The resolved identity of one request, stored as a request extension by
/// the outermost middleware so every later layer, handler and the IPC
/// request agree on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    /// The client's IP: the peer, or the first address left of the trusted
    /// proxies in the forwarding chain.
    pub ip: IpAddr,
    /// The TCP peer that sent the request (the proxy, behind one).
    pub peer: SocketAddr,
    /// `"https"` or `"http"`, as the client used it.
    pub scheme: &'static str,
    /// The host the client asked for, or None when the request named none.
    pub host: Option<String>,
    /// Unique per request; on every response as `X-Request-Id`.
    pub request_id: String,
}

impl ClientInfo {
    /// The client as a socket address for per-connection logs and the
    /// worker's `ws_connect` frame. Port 0 when the IP came from a proxy:
    /// the client's source port is unknown there.
    pub fn addr(&self) -> SocketAddr {
        if self.ip == self.peer.ip().to_canonical() {
            self.peer
        } else {
            SocketAddr::new(self.ip, 0)
        }
    }
}

/// Resolve the client behind `peer` from the request head.
pub fn resolve(
    peer: SocketAddr,
    headers: &HeaderMap,
    uri_authority: Option<&str>,
    trust: &ProxyTrust,
) -> ClientInfo {
    let peer_ip = peer.ip().to_canonical();
    let direct_host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or(uri_authority)
        .filter(|h| valid_host(h))
        .map(str::to_string);
    let direct_scheme = if trust.tls { "https" } else { "http" };
    let via_trusted = !trust.trusted.is_empty() && trust.trusted.contains(peer_ip);

    let (ip, scheme, host) = if !via_trusted {
        (peer_ip, direct_scheme, direct_host)
    } else {
        match trust.headers {
            ProxyHeaders::XForwarded => {
                let ip = joined(headers, "x-forwarded-for")
                    .and_then(|chain| client_from_x_forwarded_for(&chain, &trust.trusted))
                    .unwrap_or(peer_ip);
                let scheme = first_value(headers, "x-forwarded-proto")
                    .and_then(parse_scheme)
                    .unwrap_or(direct_scheme);
                let host = first_value(headers, "x-forwarded-host")
                    .filter(|h| valid_host(h))
                    .map(str::to_string)
                    .or(direct_host);
                (ip, scheme, host)
            }
            ProxyHeaders::Forwarded => {
                match joined(headers, "forwarded")
                    .and_then(|value| client_from_forwarded(&value, &trust.trusted))
                {
                    Some(hop) => (
                        hop.ip,
                        hop.proto.unwrap_or(direct_scheme),
                        hop.host.or(direct_host),
                    ),
                    None => (peer_ip, direct_scheme, direct_host),
                }
            }
        }
    };

    let request_id = via_trusted
        .then(|| headers.get(REQUEST_ID_HEADER))
        .flatten()
        .and_then(|v| v.to_str().ok())
        .filter(|id| valid_request_id(id))
        .map(str::to_string)
        .unwrap_or_else(generate_request_id);

    ClientInfo {
        ip,
        peer,
        scheme,
        host,
        request_id,
    }
}

/// All values of a possibly repeated list header, comma-joined in order (the
/// HTTP list-header equivalence). None when absent, non-ASCII or oversized.
fn joined(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut out = String::new();
    for value in headers.get_all(name) {
        let value = value.to_str().ok()?;
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(value);
        if out.len() > MAX_FORWARDED_LEN {
            return None;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The leftmost value of a list header: what the outermost proxy (the one
/// the client talked to) recorded, when a chain of proxies appended theirs.
fn first_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let value = headers.get(name)?.to_str().ok()?;
    Some(value.split(',').next().unwrap_or("").trim()).filter(|v| !v.is_empty())
}

fn parse_scheme(value: &str) -> Option<&'static str> {
    if value.eq_ignore_ascii_case("https") {
        Some("https")
    } else if value.eq_ignore_ascii_case("http") {
        Some("http")
    } else {
        None
    }
}

/// Host header syntax: a reg-name, IPv4 or bracketed IPv6, optional port.
/// Rejects anything that could smuggle a path, userinfo or whitespace into a
/// URL built from it.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && host.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']')
        })
}

/// Walk an X-Forwarded-For chain right to left and return the first address
/// no trusted proxy vouches for, or the leftmost when every hop is trusted.
/// None (use the peer) when a hop that has to be read is malformed.
pub fn client_from_x_forwarded_for(chain: &str, trusted: &TrustedProxies) -> Option<IpAddr> {
    let mut leftmost = None;
    for raw in chain.rsplit(',') {
        let ip = parse_node(raw.trim())?;
        if !trusted.contains(ip) {
            return Some(ip);
        }
        leftmost = Some(ip);
    }
    leftmost
}

/// A forwarded node address: an IP, optionally with a port (`1.2.3.4:80`,
/// `[2001:db8::1]:443`, bracketed or bare IPv6). `unknown` and obfuscated
/// identifiers are not addresses.
fn parse_node(raw: &str) -> Option<IpAddr> {
    if let Ok(ip) = raw.parse::<IpAddr>() {
        return Some(ip.to_canonical());
    }
    if let Ok(addr) = raw.parse::<SocketAddr>() {
        return Some(addr.ip().to_canonical());
    }
    let inner = raw.strip_prefix('[')?.strip_suffix(']')?;
    inner
        .parse::<std::net::Ipv6Addr>()
        .ok()
        .map(|v6| IpAddr::V6(v6).to_canonical())
}

/// The client hop of a `Forwarded` header.
#[derive(Debug, PartialEq, Eq)]
struct ForwardedHop {
    ip: IpAddr,
    proto: Option<&'static str>,
    host: Option<String>,
}

/// RFC 7239: elements are comma-separated, one per proxy, left to right from
/// the client; each element's `proto`/`host` describe the request that proxy
/// received. Same right-to-left walk as X-Forwarded-For over the `for=`
/// values; the chosen hop's own proto and host come with it. None when any
/// element that has to be read is malformed or lacks a usable `for=`.
fn client_from_forwarded(value: &str, trusted: &TrustedProxies) -> Option<ForwardedHop> {
    let elements = split_unquoted(value, ',')?;
    let mut leftmost = None;
    for element in elements.iter().rev() {
        let hop = parse_forwarded_element(element)?;
        if !trusted.contains(hop.ip) {
            return Some(hop);
        }
        leftmost = Some(hop);
    }
    leftmost
}

fn parse_forwarded_element(element: &str) -> Option<ForwardedHop> {
    let mut ip = None;
    let mut proto = None;
    let mut host = None;
    for pair in split_unquoted(element, ';')? {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let (name, value) = pair.split_once('=')?;
        let value = unquote(value.trim())?;
        // A repeated parameter in one element is ambiguous - malformed.
        match name.trim().to_ascii_lowercase().as_str() {
            "for" if ip.is_none() => ip = Some(parse_node(&value)?),
            "proto" if proto.is_none() => proto = Some(parse_scheme(&value)?),
            "host" if host.is_none() && valid_host(&value) => host = Some(value),
            "for" | "proto" | "host" => return None,
            _ => {}
        }
    }
    Some(ForwardedHop {
        ip: ip?,
        proto,
        host,
    })
}

/// Split on `sep` outside double-quoted strings. None on an unterminated
/// quote.
fn split_unquoted(value: &str, sep: char) -> Option<Vec<&str>> {
    let mut parts = Vec::new();
    let mut in_quotes = false;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in value.char_indices() {
        if escaped {
            escaped = false;
        } else if in_quotes && c == '\\' {
            escaped = true;
        } else if c == '"' {
            in_quotes = !in_quotes;
        } else if c == sep && !in_quotes {
            parts.push(&value[start..i]);
            start = i + c.len_utf8();
        }
    }
    if in_quotes {
        return None;
    }
    parts.push(&value[start..]);
    Some(parts)
}

/// A token or quoted-string parameter value, unescaped.
fn unquote(value: &str) -> Option<String> {
    let Some(inner) = value.strip_prefix('"') else {
        return Some(value.to_string()).filter(|v| !v.contains('"'));
    };
    let inner = inner.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push(chars.next()?),
            '"' => return None,
            c => out.push(c),
        }
    }
    Some(out)
}

/// `^[A-Za-z0-9._:-]{1,128}$`: safe to echo in a header and to log verbatim.
pub fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REQUEST_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

pub fn generate_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The host the client addressed, honoring a trusted proxy's
/// `X-Forwarded-Host` / `Forwarded: host=`. Same-origin checks (CSRF,
/// WebSocket Origin) compare the browser's Origin against THIS, not the raw
/// Host header: behind a proxy that rewrites Host to an upstream name, the
/// raw header never matches the origin the browser saw.
// The one host source for same-origin checks; their callers land with the
// security middleware, until then only the tests call it.
#[allow(dead_code)]
pub fn effective_host<B>(req: &axum::http::Request<B>) -> Option<String> {
    if let Some(client) = req.extensions().get::<ClientInfo>() {
        return client.host.clone();
    }
    req.headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_string()))
}

/// The client IP of a request: ClientInfo when the identity middleware ran,
/// else the raw peer (routers built without the outer layer, as in tests).
pub fn client_ip<B>(req: &axum::http::Request<B>, peer: SocketAddr) -> IpAddr {
    req.extensions()
        .get::<ClientInfo>()
        .map_or_else(|| peer.ip().to_canonical(), |client| client.ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn trust(list: &[&str]) -> TrustedProxies {
        TrustedProxies(list.iter().map(|entry| entry.parse().unwrap()).collect())
    }

    fn proxy_trust(list: &[&str]) -> ProxyTrust {
        ProxyTrust {
            trusted: trust(list),
            headers: ProxyHeaders::XForwarded,
            tls: false,
        }
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn peer(addr: &str) -> SocketAddr {
        addr.parse().unwrap()
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    // ── CIDR matching ─────────────────────────────────────────────────────────

    #[test]
    fn single_addresses_and_cidr_blocks_match() {
        let t = trust(&[
            "127.0.0.1",
            "10.0.0.0/8",
            "::1",
            "fd00::/8",
            "192.168.1.0/24",
        ]);
        assert!(t.contains(ip("127.0.0.1")));
        assert!(!t.contains(ip("127.0.0.2")));
        assert!(t.contains(ip("10.255.3.4")));
        assert!(!t.contains(ip("11.0.0.1")));
        assert!(t.contains(ip("192.168.1.200")));
        assert!(!t.contains(ip("192.168.2.1")));
        assert!(t.contains(ip("::1")));
        assert!(t.contains(ip("fd12:3456::1")));
        assert!(!t.contains(ip("fe80::1")));
    }

    #[test]
    fn families_never_cross_but_mapped_ipv4_is_ipv4() {
        let t = trust(&["10.0.0.0/8"]);
        // A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d.
        assert!(t.contains(ip("::ffff:10.1.2.3")));
        assert!(
            !t.contains(ip("::a01:203")),
            "IPv4-compatible is not mapped"
        );
        let v6 = trust(&["::/0"]);
        assert!(v6.contains(ip("2001:db8::1")));
        assert!(
            !v6.contains(ip("10.0.0.1")),
            "an IPv6 block never covers IPv4"
        );
        assert!(trust(&["::ffff:10.0.0.1"]).contains(ip("10.0.0.1")));
    }

    #[test]
    fn edge_prefixes_and_host_bits() {
        assert!(trust(&["0.0.0.0/0"]).contains(ip("203.0.113.9")));
        assert!(
            trust(&["10.1.2.3/8"]).contains(ip("10.9.9.9")),
            "host bits masked"
        );
        assert_eq!(
            "10.1.2.3/8".parse::<IpNet>().unwrap().to_string(),
            "10.0.0.0/8"
        );
        assert_eq!(
            "2001:db8::1/32".parse::<IpNet>().unwrap().to_string(),
            "2001:db8::/32"
        );
        assert!(trust(&["2001:db8::1/128"]).contains(ip("2001:db8::1")));
        assert!(!trust(&["2001:db8::1/128"]).contains(ip("2001:db8::2")));
    }

    #[test]
    fn malformed_entries_are_rejected() {
        for bad in [
            "",
            "10.0.0.0/33",
            "::/129",
            "10.0.0.0/",
            "10.0.0.0/-1",
            "10.0.0.0/+8",
            "10.0.0",
            "localhost",
            "10.0.0.0/8/8",
            "*",
            "1.2.3.4:80",
        ] {
            assert!(bad.parse::<IpNet>().is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn trusted_proxies_deserialize_strictly() {
        #[derive(Deserialize)]
        struct Wrapper {
            trusted_proxies: TrustedProxies,
        }
        let ok: Wrapper =
            toml::from_str(r#"trusted_proxies = ["127.0.0.1", "10.0.0.0/8", "::1"]"#).unwrap();
        assert_eq!(ok.trusted_proxies.entries().len(), 3);
        let err = toml::from_str::<Wrapper>(r#"trusted_proxies = ["10.0.0.0/40"]"#)
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("invalid trusted_proxies entry"), "{err}");
    }

    // ── X-Forwarded-For ───────────────────────────────────────────────────────

    #[test]
    fn untrusted_peers_cannot_spoof_anything() {
        let h = headers(&[
            ("x-forwarded-for", "1.2.3.4"),
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "evil.example"),
            ("host", "app.example"),
            ("x-request-id", "spoofed-id"),
        ]);
        let info = resolve(
            peer("203.0.113.7:5000"),
            &h,
            None,
            &proxy_trust(&["127.0.0.1"]),
        );
        assert_eq!(info.ip, ip("203.0.113.7"));
        assert_eq!(info.scheme, "http");
        assert_eq!(info.host.as_deref(), Some("app.example"));
        assert_ne!(info.request_id, "spoofed-id");
    }

    #[test]
    fn no_trusted_proxies_means_the_peer_is_the_client() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4")]);
        let info = resolve(peer("127.0.0.1:5000"), &h, None, &ProxyTrust::default());
        assert_eq!(info.ip, ip("127.0.0.1"));
        assert_eq!(info.addr(), peer("127.0.0.1:5000"));
    }

    #[test]
    fn trusted_peer_yields_the_forwarded_client() {
        let h = headers(&[("x-forwarded-for", "198.51.100.4")]);
        let info = resolve(
            peer("127.0.0.1:5000"),
            &h,
            None,
            &proxy_trust(&["127.0.0.1"]),
        );
        assert_eq!(info.ip, ip("198.51.100.4"));
        assert_eq!(
            info.addr(),
            peer("198.51.100.4:0"),
            "client port is unknown"
        );
    }

    #[test]
    fn chain_walks_right_to_left_past_trusted_hops() {
        let t = trust(&["127.0.0.1", "10.0.0.0/8"]);
        // client-supplied junk, real client, CDN edge (trusted), LB (trusted)
        let chain = "6.6.6.6, 198.51.100.4, 10.0.0.7, 10.1.0.2";
        assert_eq!(
            client_from_x_forwarded_for(chain, &t),
            Some(ip("198.51.100.4"))
        );
        // A spoofed leftmost entry is never reached.
        assert_eq!(
            client_from_x_forwarded_for("1.1.1.1, 198.51.100.4", &t),
            Some(ip("198.51.100.4"))
        );
        // Every hop trusted: the leftmost is the best answer there is.
        assert_eq!(
            client_from_x_forwarded_for("10.0.0.5, 10.0.0.6", &t),
            Some(ip("10.0.0.5"))
        );
    }

    #[test]
    fn repeated_header_lines_form_one_chain() {
        let h = headers(&[
            ("x-forwarded-for", "6.6.6.6"),
            ("x-forwarded-for", "198.51.100.4, 10.0.0.7"),
        ]);
        let info = resolve(
            peer("127.0.0.1:1"),
            &h,
            None,
            &proxy_trust(&["127.0.0.1", "10.0.0.0/8"]),
        );
        assert_eq!(info.ip, ip("198.51.100.4"));
    }

    #[test]
    fn ipv6_and_ported_entries_parse() {
        let t = trust(&["::1", "10.0.0.0/8"]);
        assert_eq!(
            client_from_x_forwarded_for("2001:db8::7, ::1", &t),
            Some(ip("2001:db8::7"))
        );
        assert_eq!(
            client_from_x_forwarded_for("[2001:db8::7]:443", &t),
            Some(ip("2001:db8::7"))
        );
        assert_eq!(
            client_from_x_forwarded_for("[2001:db8::7]", &t),
            Some(ip("2001:db8::7"))
        );
        assert_eq!(
            client_from_x_forwarded_for("198.51.100.4:6000, 10.0.0.1", &t),
            Some(ip("198.51.100.4"))
        );
        assert_eq!(
            client_from_x_forwarded_for("::ffff:198.51.100.4", &t),
            Some(ip("198.51.100.4")),
            "mapped addresses are their IPv4 address"
        );
        // An IPv6 peer is trusted like any other.
        let h = headers(&[("x-forwarded-for", "2001:db8::42")]);
        let info = resolve(peer("[::1]:9000"), &h, None, &proxy_trust(&["::1"]));
        assert_eq!(info.ip, ip("2001:db8::42"));
    }

    #[test]
    fn malformed_values_fall_back_to_the_peer() {
        let pt = proxy_trust(&["127.0.0.1", "10.0.0.0/8"]);
        for chain in [
            "not-an-ip",
            "unknown",
            "198.51.100.4, garbage",
            "198.51.100.4,,10.0.0.1",
            "",
            " , ",
            "1.2.3.4.5",
            "[::1",
        ] {
            let h = headers(&[("x-forwarded-for", chain)]);
            let info = resolve(peer("127.0.0.1:1"), &h, None, &pt);
            assert_eq!(info.ip, ip("127.0.0.1"), "{chain:?}");
        }
        // Malformed entries LEFT of the client are never read.
        assert_eq!(
            client_from_x_forwarded_for("garbage, 198.51.100.4", &pt.trusted),
            Some(ip("198.51.100.4"))
        );
        // Oversized chains are malformed, not walked.
        let huge = vec!["10.0.0.1"; 2000].join(",");
        let h = headers(&[("x-forwarded-for", &huge)]);
        assert_eq!(
            resolve(peer("127.0.0.1:1"), &h, None, &pt).ip,
            ip("127.0.0.1")
        );
    }

    #[test]
    fn non_ascii_header_bytes_are_malformed() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_bytes(b"198.51.100.4\xff").unwrap(),
        );
        let info = resolve(peer("127.0.0.1:1"), &h, None, &proxy_trust(&["127.0.0.1"]));
        assert_eq!(info.ip, ip("127.0.0.1"));
    }

    // ── scheme / host ─────────────────────────────────────────────────────────

    #[test]
    fn scheme_comes_from_a_trusted_proxy_or_the_listener() {
        let h = headers(&[("x-forwarded-proto", "HTTPS")]);
        let pt = proxy_trust(&["127.0.0.1"]);
        assert_eq!(resolve(peer("127.0.0.1:1"), &h, None, &pt).scheme, "https");
        assert_eq!(resolve(peer("192.0.2.1:1"), &h, None, &pt).scheme, "http");
        let tls = ProxyTrust {
            tls: true,
            ..pt.clone()
        };
        assert_eq!(
            resolve(peer("192.0.2.1:1"), &HeaderMap::new(), None, &tls).scheme,
            "https"
        );
        // A TLS-terminating proxy in front of a TLS listener still decides.
        let h = headers(&[("x-forwarded-proto", "http")]);
        assert_eq!(resolve(peer("127.0.0.1:1"), &h, None, &tls).scheme, "http");
        // Chains take the outermost proxy's value; junk falls back.
        let h = headers(&[("x-forwarded-proto", "https, http")]);
        assert_eq!(resolve(peer("127.0.0.1:1"), &h, None, &pt).scheme, "https");
        let h = headers(&[("x-forwarded-proto", "javascript")]);
        assert_eq!(resolve(peer("127.0.0.1:1"), &h, None, &pt).scheme, "http");
    }

    #[test]
    fn host_comes_from_a_trusted_proxy_or_the_host_header() {
        let pt = proxy_trust(&["127.0.0.1"]);
        let h = headers(&[
            ("host", "upstream:3000"),
            ("x-forwarded-host", "app.example"),
        ]);
        assert_eq!(
            resolve(peer("127.0.0.1:1"), &h, None, &pt).host.as_deref(),
            Some("app.example")
        );
        assert_eq!(
            resolve(peer("192.0.2.1:1"), &h, None, &pt).host.as_deref(),
            Some("upstream:3000")
        );
        // Invalid forwarded hosts fall back to Host.
        for bad in ["evil.example/path", "user@evil.example", "a b", ""] {
            let h = headers(&[("host", "upstream:3000"), ("x-forwarded-host", bad)]);
            assert_eq!(
                resolve(peer("127.0.0.1:1"), &h, None, &pt).host.as_deref(),
                Some("upstream:3000"),
                "{bad:?}"
            );
        }
        // HTTP/2 requests carry :authority instead of Host.
        assert_eq!(
            resolve(
                peer("192.0.2.1:1"),
                &HeaderMap::new(),
                Some("h2.example"),
                &pt
            )
            .host
            .as_deref(),
            Some("h2.example")
        );
        let h = headers(&[("host", "[::1]:3000")]);
        assert_eq!(
            resolve(peer("192.0.2.1:1"), &h, None, &pt).host.as_deref(),
            Some("[::1]:3000")
        );
    }

    #[test]
    fn effective_host_prefers_the_resolved_identity() {
        let mut req = axum::http::Request::builder()
            .uri("/")
            .header("host", "upstream:3000")
            .body(())
            .unwrap();
        assert_eq!(effective_host(&req).as_deref(), Some("upstream:3000"));
        req.extensions_mut().insert(ClientInfo {
            ip: ip("198.51.100.4"),
            peer: peer("127.0.0.1:1"),
            scheme: "https",
            host: Some("app.example".into()),
            request_id: "id".into(),
        });
        assert_eq!(effective_host(&req).as_deref(), Some("app.example"));
    }

    // ── Forwarded (RFC 7239) ──────────────────────────────────────────────────

    fn forwarded_trust(list: &[&str]) -> ProxyTrust {
        ProxyTrust {
            trusted: trust(list),
            headers: ProxyHeaders::Forwarded,
            tls: false,
        }
    }

    #[test]
    fn forwarded_header_yields_client_proto_and_host() {
        let h = headers(&[
            ("host", "upstream"),
            (
                "forwarded",
                r#"for=198.51.100.4;proto=https;host=app.example, for="[2001:db8::1]:8080";proto=http"#,
            ),
        ]);
        let info = resolve(
            peer("127.0.0.1:1"),
            &h,
            None,
            &forwarded_trust(&["127.0.0.1", "2001:db8::/32"]),
        );
        assert_eq!(info.ip, ip("198.51.100.4"));
        assert_eq!(info.scheme, "https");
        assert_eq!(info.host.as_deref(), Some("app.example"));
    }

    #[test]
    fn forwarded_mode_ignores_x_forwarded_and_vice_versa() {
        let h = headers(&[
            ("x-forwarded-for", "6.6.6.6"),
            ("forwarded", "for=198.51.100.4"),
        ]);
        let fwd = resolve(
            peer("127.0.0.1:1"),
            &h,
            None,
            &forwarded_trust(&["127.0.0.1"]),
        );
        assert_eq!(fwd.ip, ip("198.51.100.4"));
        let xff = resolve(peer("127.0.0.1:1"), &h, None, &proxy_trust(&["127.0.0.1"]));
        assert_eq!(xff.ip, ip("6.6.6.6"));
    }

    #[test]
    fn forwarded_parsing_is_strict() {
        let t = trust(&["127.0.0.1"]);
        assert_eq!(
            client_from_forwarded(r#"for="198.51.100.4:80""#, &t).map(|h| h.ip),
            Some(ip("198.51.100.4"))
        );
        assert_eq!(
            client_from_forwarded(r#"For="[2001:db8::1]";by=10.0.0.1"#, &t).map(|h| h.ip),
            Some(ip("2001:db8::1"))
        );
        // Quoted commas and semicolons do not split.
        assert_eq!(
            client_from_forwarded(r#"for=198.51.100.4;ext="a,b;c""#, &t).map(|h| h.ip),
            Some(ip("198.51.100.4"))
        );
        for bad in [
            "for=unknown",
            "for=_hidden",
            "proto=https",
            "for=198.51.100.4;for=1.2.3.4",
            r#"for="198.51.100.4"#,
            "for=198.51.100.4;proto=gopher",
            "garbage",
        ] {
            assert_eq!(client_from_forwarded(bad, &t), None, "{bad:?}");
        }
        let h = headers(&[("forwarded", "for=unknown"), ("host", "upstream")]);
        let info = resolve(
            peer("127.0.0.1:1"),
            &h,
            None,
            &forwarded_trust(&["127.0.0.1"]),
        );
        assert_eq!(info.ip, ip("127.0.0.1"));
        assert_eq!(info.host.as_deref(), Some("upstream"));
    }

    // ── request ids ───────────────────────────────────────────────────────────

    #[test]
    fn request_id_validation() {
        for good in [
            "a",
            "abc-123",
            "1-5759e988-bd862e3fe1be46a994272793",
            "x.y_z:1",
        ] {
            assert!(valid_request_id(good), "{good:?}");
        }
        assert!(valid_request_id(&"a".repeat(128)));
        for bad in [
            "",
            "has space",
            "semi;colon",
            "quote\"",
            "ünïcode",
            "a/b",
            "\t",
        ] {
            assert!(!valid_request_id(bad), "{bad:?}");
        }
        assert!(!valid_request_id(&"a".repeat(129)));
        assert!(valid_request_id(&generate_request_id()));
    }

    #[test]
    fn request_id_is_accepted_only_from_trusted_peers() {
        let pt = proxy_trust(&["127.0.0.1"]);
        let h = headers(&[("x-request-id", "lb-abc.123")]);
        assert_eq!(
            resolve(peer("127.0.0.1:1"), &h, None, &pt).request_id,
            "lb-abc.123"
        );
        let untrusted = resolve(peer("192.0.2.1:1"), &h, None, &pt).request_id;
        assert_ne!(untrusted, "lb-abc.123");
        assert!(valid_request_id(&untrusted));
        // Invalid ids from a trusted proxy are replaced, not echoed.
        let h = headers(&[("x-request-id", "bad id")]);
        let replaced = resolve(peer("127.0.0.1:1"), &h, None, &pt).request_id;
        assert_ne!(replaced, "bad id");
        assert!(valid_request_id(&replaced));
        // Generated ids are unique.
        let a = resolve(peer("192.0.2.1:1"), &HeaderMap::new(), None, &pt).request_id;
        let b = resolve(peer("192.0.2.1:1"), &HeaderMap::new(), None, &pt).request_id;
        assert_ne!(a, b);
    }
}
