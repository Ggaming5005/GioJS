//! giojs-server/src/dev_guard.rs
//!
//! Request vetting for the dev-only /_gio/devtools* endpoints. They read
//! project source (codeframe) and spawn the user's editor (open-in-editor),
//! while the starter gio.toml binds 0.0.0.0, so two browser-borne attacks
//! must be shut out:
//!
//! - DNS rebinding: an attacker's domain re-resolves to 127.0.0.1 and its
//!   page reads responses same-origin. The Host header still carries the
//!   attacker's domain, so only localhost-style hosts (plus the configured
//!   bind address and `[dev] allowed_hosts`) are answered.
//! - Cross-site requests: `<img src>` / form posts from any website. Origin
//!   and Sec-Fetch-Site expose these; the privileged endpoint is POST-only
//!   (enforced by the router) and must be same-origin.
//!
//! Anyone who can reach the port directly can forge every header checked
//! here, `Host: localhost` included. So the localhost-style hosts are only
//! trusted on a connection from this machine (a loopback peer address); a
//! client on another machine must name the bind address or a host listed in
//! `[dev] allowed_hosts`. Listing a host there opts in to that host from any
//! peer, which is what a LAN device, a VM or a container's port mapping needs.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::net::IpAddr;
use std::sync::{Mutex, PoisonError};

/// Distinct rejections logged at warn level before the guard goes quiet
/// (see `DevHostPolicy::should_warn`).
const MAX_WARNED_REJECTIONS: usize = 16;

/// Replaces a render error page's message and stack when the request's Host
/// is not trusted: a DNS-rebinding page could otherwise read them.
pub const HIDDEN_ERROR_DETAILS: &str = "This page failed to render. Error details are only \
     shown on localhost hosts (DNS rebinding protection); the dev server's terminal has them. \
     To see them through this host, add its hostname to [dev] allowed_hosts in gio.toml.";

/// How much an endpoint is allowed to do, which decides how strictly the
/// browser-supplied provenance headers are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevEndpointKind {
    /// The dashboard HTML: opened by top-level navigation, often from a link
    /// on another site, so only the Host is checked. A cross-site page cannot
    /// read the response anyway.
    Page,
    /// Endpoints returning source or live server state (codeframe, state,
    /// stream): cross-site and foreign-Origin requests are refused.
    Read,
    /// Endpoints with side effects (open-in-editor): only same-origin or
    /// user-initiated (`none`) requests are accepted.
    Privileged,
}

impl DevEndpointKind {
    pub fn for_path(path: &str) -> Self {
        match path {
            "/_gio/devtools" | "/_gio/devtools/" => Self::Page,
            "/_gio/devtools/open-in-editor" => Self::Privileged,
            _ => Self::Read,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DevGuardRejection {
    MissingHost,
    UntrustedHost(String),
    /// A localhost-style Host (normalized, no port) on a connection from
    /// another machine: the header is forged, or a port mapping rewrote it.
    RemotePeer(String),
    CrossSite(String),
    ForeignOrigin(String),
}

impl DevGuardRejection {
    /// Human-readable 403 body. The host case spells out the gio.toml fix
    /// because it is what a developer opening the dev server from a VM or
    /// phone will hit.
    pub fn message(&self) -> String {
        match self {
            Self::MissingHost => "GioJS dev endpoints require a Host header.\n".to_string(),
            Self::UntrustedHost(host) => format!(
                "GioJS dev endpoints only answer to localhost hosts (DNS rebinding protection); \
                 \"{host}\" is not allowed.\n\
                 To use them through this host, add it to gio.toml:\n\n\
                 [dev]\nallowed_hosts = [\"{host}\"]\n"
            ),
            Self::RemotePeer(host) => format!(
                "GioJS dev endpoints only answer \"{host}\" to requests from this machine.\n\
                 To use them from another device, browse to a hostname or IP of this machine \
                 and add it to gio.toml:\n\n\
                 [dev]\nallowed_hosts = [\"192.168.1.20\"]\n\n\
                 (Behind a container port mapping that connects from another address, list \
                 \"{host}\" itself.)\n"
            ),
            Self::CrossSite(site) => format!(
                "GioJS dev endpoints refuse requests with Sec-Fetch-Site: {site}; \
                 call them from a page served by this dev server.\n"
            ),
            // Allowing the host cannot help a cross-site request (the browser
            // decides Sec-Fetch-Site), but it is the fix for a foreign Origin
            // behind a proxy or tunnel that rewrites Host to localhost.
            Self::ForeignOrigin(origin) => {
                let mut msg = format!(
                    "GioJS dev endpoints refuse requests from origin \"{origin}\"; \
                     call them from a page served by this dev server.\n"
                );
                if let Some(host) = origin_hostname(origin) {
                    msg.push_str(&format!(
                        "If that origin is a proxy or tunnel in front of this dev server \
                         (one that rewrites the Host header), allow it in gio.toml:\n\n\
                         [dev]\nallowed_hosts = [\"{host}\"]\n"
                    ));
                }
                msg
            }
        }
    }
}

/// Hosts the dev endpoints answer to, normalized to lowercase hostnames
/// without port or IPv6 brackets.
#[derive(Debug, Default)]
pub struct DevHostPolicy {
    /// The bind address when it names one interface (not 0.0.0.0 / ::).
    bind_host: Option<String>,
    /// `[dev] allowed_hosts`. Entries starting with `.` match subdomains.
    allowed_hosts: Vec<String>,
    /// `[dev] allowed_hosts` entries that are not a hostname or IP, verbatim,
    /// so startup can name them instead of silently dropping them.
    invalid_allowed_hosts: Vec<String>,
    /// Hashes of the rejections already logged at warn level.
    warned: Mutex<HashSet<u64>>,
}

impl DevHostPolicy {
    pub fn new(bind_host: &str, allowed_hosts: &[String]) -> Self {
        let bind_host = normalize_hostname(bind_host)
            .filter(|host| !host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()));
        let mut allowed = Vec::new();
        let mut invalid = Vec::new();
        for entry in allowed_hosts {
            match parse_allowed_host(entry) {
                Some(host) => allowed.push(host),
                None => invalid.push(entry.clone()),
            }
        }
        Self {
            bind_host,
            allowed_hosts: allowed,
            invalid_allowed_hosts: invalid,
            warned: Mutex::default(),
        }
    }

    /// Whether a Host header value (`name[:port]`) is trusted on a
    /// connection from this machine.
    #[cfg(test)]
    pub fn is_trusted_host(&self, host_header: &str) -> bool {
        normalize_hostname(host_header).is_some_and(|host| self.is_trusted_hostname(&host))
    }

    /// Whether a Host header value is trusted on a connection from `peer`
    /// (`None` when the transport has no peer address). From another
    /// machine every header is forgeable, so only the hosts the developer
    /// configured (the bind address, `[dev] allowed_hosts`) are trusted.
    pub fn is_trusted_host_from(&self, host_header: &str, peer: Option<IpAddr>) -> bool {
        self.host_verdict(host_header, peer).is_ok()
    }

    fn host_verdict(
        &self,
        host_header: &str,
        peer: Option<IpAddr>,
    ) -> Result<(), DevGuardRejection> {
        let Some(host) = normalize_hostname(host_header) else {
            return Err(DevGuardRejection::UntrustedHost(host_header.to_string()));
        };
        if is_local_peer(peer) {
            return if self.is_trusted_hostname(&host) {
                Ok(())
            } else {
                Err(DevGuardRejection::UntrustedHost(host_header.to_string()))
            };
        }
        if self.bind_host.as_deref() == Some(host.as_str()) || self.is_explicitly_allowed(&host) {
            Ok(())
        } else if self.is_trusted_hostname(&host) {
            Err(DevGuardRejection::RemotePeer(host))
        } else {
            Err(DevGuardRejection::UntrustedHost(host_header.to_string()))
        }
    }

    fn is_trusted_hostname(&self, host: &str) -> bool {
        // Loopback literals and the reserved .localhost TLD (RFC 6761) can
        // only reach this machine, so an attacker cannot rebind onto them.
        host == "localhost"
            || host.ends_with(".localhost")
            || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
            || self.bind_host.as_deref() == Some(host)
            || self.is_explicitly_allowed(host)
    }

    fn is_explicitly_allowed(&self, host: &str) -> bool {
        self.allowed_hosts
            .iter()
            .any(|allowed| match allowed.strip_prefix('.') {
                Some(suffix) => host == suffix || host.ends_with(allowed.as_str()),
                None => host == allowed,
            })
    }

    /// `check_from` on a connection from this machine.
    #[cfg(test)]
    pub fn check(
        &self,
        kind: DevEndpointKind,
        host: Option<&str>,
        origin: Option<&str>,
        sec_fetch_site: Option<&str>,
    ) -> Result<(), DevGuardRejection> {
        self.check_from(kind, host, origin, sec_fetch_site, None)
    }

    /// Vet one dev endpoint request. `host` is the Host header (or the
    /// HTTP/2 :authority); `origin` and `sec_fetch_site` are the raw headers;
    /// `peer` is the connection's remote address.
    pub fn check_from(
        &self,
        kind: DevEndpointKind,
        host: Option<&str>,
        origin: Option<&str>,
        sec_fetch_site: Option<&str>,
        peer: Option<IpAddr>,
    ) -> Result<(), DevGuardRejection> {
        let host = host
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .ok_or(DevGuardRejection::MissingHost)?;
        self.host_verdict(host, peer)?;
        if kind == DevEndpointKind::Page {
            return Ok(());
        }

        if let Some(site) = sec_fetch_site.map(|s| s.trim().to_ascii_lowercase()) {
            let allowed = match kind {
                DevEndpointKind::Privileged => site == "same-origin" || site == "none",
                _ => site != "cross-site",
            };
            if !allowed {
                return Err(DevGuardRejection::CrossSite(site));
            }
        }
        if let Some(origin) = origin.map(str::trim) {
            if !self.origin_matches(origin, host) {
                return Err(DevGuardRejection::ForeignOrigin(origin.to_string()));
            }
        }
        Ok(())
    }

    /// Origin must name the host the request was sent to. A host listed in
    /// `[dev] allowed_hosts` is also accepted as an Origin, because port
    /// forwarders (Codespaces, VS Code tunnels) rewrite Host to localhost
    /// while the browser's Origin keeps the public name.
    fn origin_matches(&self, origin: &str, host: &str) -> bool {
        // "null" (sandboxed iframes, file://) has no authority and never matches.
        let Some(authority) = origin_authority(origin) else {
            return false;
        };
        if authority.eq_ignore_ascii_case(host) {
            return true;
        }
        normalize_hostname(authority).is_some_and(|h| self.is_explicitly_allowed(&h))
    }

    pub fn allowed_hosts(&self) -> &[String] {
        &self.allowed_hosts
    }

    pub fn invalid_allowed_hosts(&self) -> &[String] {
        &self.invalid_allowed_hosts
    }

    /// Whether a blocked request deserves a warn-level log line. /_gio/* is
    /// exempt from rate limiting, so a page looping `new Image().src = ...`
    /// at a dev endpoint would otherwise flood the terminal: each distinct
    /// rejection (kind + offending host / origin) is reported once, up to
    /// MAX_WARNED_REJECTIONS of them, and the rest belong at debug level.
    pub fn should_warn(&self, rejection: &DevGuardRejection) -> bool {
        // A hash, not the header value itself, keeps the set's memory fixed.
        let mut hasher = DefaultHasher::new();
        rejection.hash(&mut hasher);
        let mut warned = self.warned.lock().unwrap_or_else(PoisonError::into_inner);
        warned.len() < MAX_WARNED_REJECTIONS && warned.insert(hasher.finish())
    }
}

/// `https://abc.example:8443/` -> `abc.example:8443`. `None` for "null".
fn origin_authority(origin: &str) -> Option<&str> {
    let (_, authority) = origin.split_once("://")?;
    Some(authority.trim_end_matches('/'))
}

/// The hostname an Origin names, normalized like a Host header.
fn origin_hostname(origin: &str) -> Option<String> {
    origin_authority(origin).and_then(normalize_hostname)
}

/// One `[dev] allowed_hosts` entry -> its normalized form (`.suffix` for a
/// subdomain wildcard), or `None` when it is not a hostname or IP. Accepts
/// the `*.example.com` spelling other dev servers use, and a pasted URL
/// (`http://myvm.local:3000/`) for its host.
fn parse_allowed_host(entry: &str) -> Option<String> {
    let mut entry = entry.trim();
    for scheme in ["http://", "https://"] {
        if entry
            .get(..scheme.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
        {
            entry = &entry[scheme.len()..];
            break;
        }
    }
    let entry = entry.strip_suffix('/').unwrap_or(entry);
    match entry.strip_prefix("*.").or_else(|| entry.strip_prefix('.')) {
        Some(suffix) => normalize_hostname(suffix).map(|s| format!(".{s}")),
        None => normalize_hostname(entry),
    }
}

/// `Example.COM:3000` -> `example.com`, `[::1]:3000` -> `::1`. Returns
/// `None` for values that are not a plausible host.
fn normalize_hostname(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let host = if let Some(rest) = raw.strip_prefix('[') {
        // Bracketed IPv6, optionally followed by :port.
        let (inner, after) = rest.split_once(']')?;
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(is_port)) {
            return None;
        }
        inner
    } else if raw.parse::<IpAddr>().is_ok() {
        // A bare IPv6 literal (bind addresses like "::1") has colons but no port.
        raw
    } else {
        match raw.rsplit_once(':') {
            Some((name, port)) if is_port(port) => name,
            Some(_) => return None,
            None => raw,
        }
    };
    // A trailing dot is the same FQDN; strip it so "localhost." is not a bypass
    // or a spurious mismatch.
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    // No real host has a '*' or a leading '.'; rejecting them surfaces
    // misspelled wildcards in allowed_hosts instead of storing them as
    // literals that never match.
    if host.is_empty() || host.starts_with('.') || host.contains(['/', '@', ' ', '\\', '*']) {
        return None;
    }
    Some(host)
}

fn is_port(s: &str) -> bool {
    !s.is_empty() && s.len() <= 5 && s.bytes().all(|b| b.is_ascii_digit())
}

/// Whether a connection comes from this machine. An unknown peer (no
/// socket address, as in in-process tests) counts as local.
fn is_local_peer(peer: Option<IpAddr>) -> bool {
    peer.is_none_or(|ip| ip.to_canonical().is_loopback())
}

/// Whether the configured bind address listens on every interface.
pub fn binds_all_interfaces(bind_host: &str) -> bool {
    normalize_hostname(bind_host)
        .and_then(|h| h.parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_unspecified())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> DevHostPolicy {
        DevHostPolicy::new("0.0.0.0", &[])
    }

    #[test]
    fn localhost_hosts_are_trusted() {
        let p = policy();
        for host in [
            "localhost",
            "localhost:3000",
            "LOCALHOST:3000",
            "localhost.:3000",
            "127.0.0.1",
            "127.0.0.1:3000",
            "127.1.2.3:3000",
            "[::1]",
            "[::1]:3000",
            "app.localhost:3000",
        ] {
            assert!(p.is_trusted_host(host), "{host} should be trusted");
        }
    }

    #[test]
    fn foreign_hosts_are_untrusted() {
        let p = policy();
        for host in [
            "evil.example",
            "evil.example:3000",
            "localhost.evil.example",
            "evillocalhost",
            "192.168.1.20:3000",
            "0.0.0.0:3000",
            "[::]:3000",
            "localhost:abc",
            "localhost@evil.example",
            "",
        ] {
            assert!(!p.is_trusted_host(host), "{host} should be untrusted");
        }
    }

    #[test]
    fn specific_bind_host_is_trusted() {
        let p = DevHostPolicy::new("192.168.1.20", &[]);
        assert!(p.is_trusted_host("192.168.1.20:3000"));
        assert!(!p.is_trusted_host("192.168.1.21:3000"));
        let v6 = DevHostPolicy::new("fd00::1", &[]);
        assert!(v6.is_trusted_host("[fd00::1]:3000"));
    }

    #[test]
    fn unspecified_bind_host_is_not_trusted_as_a_host() {
        assert!(!DevHostPolicy::new("::", &[]).is_trusted_host("[::]:3000"));
        assert!(binds_all_interfaces("0.0.0.0"));
        assert!(binds_all_interfaces("::"));
        assert!(!binds_all_interfaces("127.0.0.1"));
        assert!(!binds_all_interfaces("localhost"));
    }

    #[test]
    fn allowed_hosts_extend_the_trusted_set() {
        let p = DevHostPolicy::new(
            "0.0.0.0",
            &[
                "192.168.1.20".to_string(),
                "MyVM.local:3000".to_string(),
                ".tunnel.example".to_string(),
            ],
        );
        assert!(p.is_trusted_host("192.168.1.20:3000"));
        assert!(p.is_trusted_host("myvm.local:3000"));
        assert!(p.is_trusted_host("myvm.local"));
        assert!(p.is_trusted_host("tunnel.example"));
        assert!(p.is_trusted_host("abc.tunnel.example:443"));
        assert!(!p.is_trusted_host("eviltunnel.example"));
        assert!(!p.is_trusted_host("other.local"));
    }

    #[test]
    fn allowed_hosts_accept_wildcard_and_url_spellings() {
        let p = DevHostPolicy::new(
            "0.0.0.0",
            &[
                "*.tunnel.example".to_string(),
                "http://MyVM.local:3000".to_string(),
                "HTTPS://box.example/".to_string(),
            ],
        );
        assert!(p.is_trusted_host("abc.tunnel.example:443"));
        assert!(p.is_trusted_host("tunnel.example"));
        assert!(!p.is_trusted_host("eviltunnel.example"));
        assert!(p.is_trusted_host("myvm.local:3000"));
        assert!(p.is_trusted_host("box.example"));
        assert!(p.invalid_allowed_hosts().is_empty());
        assert_eq!(
            p.allowed_hosts(),
            [".tunnel.example", "myvm.local", "box.example"]
        );
    }

    #[test]
    fn unusable_allowed_hosts_entries_are_reported_not_stored() {
        let entries = [
            "*",
            "*.",
            "foo*.example",
            "http://myvm.local/app",
            "",
            "..example",
            "ok.example",
        ]
        .map(String::from);
        let p = DevHostPolicy::new("0.0.0.0", &entries);
        assert_eq!(p.allowed_hosts(), ["ok.example"]);
        assert_eq!(p.invalid_allowed_hosts(), &entries[..6]);
        assert!(!p.is_trusted_host("foo*.example"));
        assert!(!p.is_trusted_host(".localhost"));
    }

    #[test]
    fn repeated_rejections_are_warned_about_once() {
        let p = policy();
        let evil = DevGuardRejection::UntrustedHost("evil.example".into());
        assert!(p.should_warn(&evil));
        assert!(
            !p.should_warn(&evil),
            "a flood of the same rejection warns once"
        );
        assert!(p.should_warn(&DevGuardRejection::ForeignOrigin(
            "https://evil.example".into()
        )));
        // Distinct values stop warning after a fixed number, so a page that
        // varies its Host / Origin cannot flood the terminal either.
        let warned = (0..100)
            .filter(|i| p.should_warn(&DevGuardRejection::UntrustedHost(format!("h{i}.example"))))
            .count();
        assert_eq!(warned, MAX_WARNED_REJECTIONS - 2);
    }

    #[test]
    fn foreign_origin_message_points_proxies_at_allowed_hosts() {
        let msg = DevGuardRejection::ForeignOrigin("https://abc.ngrok.app".into()).message();
        assert!(msg.contains("proxy or tunnel"), "{msg}");
        assert!(
            msg.contains("[dev]\nallowed_hosts = [\"abc.ngrok.app\"]"),
            "{msg}"
        );
        // An opaque origin has no hostname to suggest.
        let null = DevGuardRejection::ForeignOrigin("null".into()).message();
        assert!(!null.contains("allowed_hosts"), "{null}");
    }

    #[test]
    fn untrusted_host_is_rejected_for_every_kind() {
        let p = policy();
        for kind in [
            DevEndpointKind::Page,
            DevEndpointKind::Read,
            DevEndpointKind::Privileged,
        ] {
            assert_eq!(
                p.check(kind, Some("evil.example:3000"), None, None),
                Err(DevGuardRejection::UntrustedHost("evil.example:3000".into()))
            );
        }
        assert_eq!(
            p.check(DevEndpointKind::Read, None, None, None),
            Err(DevGuardRejection::MissingHost)
        );
    }

    #[test]
    fn localhost_host_from_another_machine_is_refused() {
        let p = policy();
        let lan: IpAddr = "192.0.2.2".parse().unwrap();
        // A LAN client forging Host: localhost (the server binds 0.0.0.0).
        for (host, name) in [
            ("localhost:4518", "localhost"),
            ("127.0.0.1:4518", "127.0.0.1"),
            ("[::1]:4518", "::1"),
            ("app.localhost", "app.localhost"),
        ] {
            assert_eq!(
                p.check_from(DevEndpointKind::Read, Some(host), None, None, Some(lan)),
                Err(DevGuardRejection::RemotePeer(name.into())),
                "{host}"
            );
            assert!(!p.is_trusted_host_from(host, Some(lan)), "{host}");
        }
        assert_eq!(
            p.check_from(
                DevEndpointKind::Read,
                Some("evil.example"),
                None,
                None,
                Some(lan)
            ),
            Err(DevGuardRejection::UntrustedHost("evil.example".into()))
        );
        // The same request over loopback (IPv4, IPv6, IPv4-mapped) is fine.
        for peer in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            let peer: IpAddr = peer.parse().unwrap();
            assert!(p
                .check_from(
                    DevEndpointKind::Read,
                    Some("localhost:4518"),
                    None,
                    None,
                    Some(peer)
                )
                .is_ok());
            assert!(p.is_trusted_host_from("localhost:4518", Some(peer)));
        }
        let msg = DevGuardRejection::RemotePeer("localhost".into()).message();
        assert!(msg.contains("allowed_hosts"), "{msg}");
        assert!(msg.contains("list \"localhost\" itself"), "{msg}");
    }

    #[test]
    fn configured_hosts_answer_other_machines() {
        let lan: IpAddr = "192.168.1.30".parse().unwrap();
        let p = DevHostPolicy::new("0.0.0.0", &["192.168.1.20".to_string()]);
        assert!(p
            .check_from(
                DevEndpointKind::Read,
                Some("192.168.1.20:3000"),
                None,
                None,
                Some(lan)
            )
            .is_ok());
        let bound = DevHostPolicy::new("192.168.1.20", &[]);
        assert!(bound.is_trusted_host_from("192.168.1.20:3000", Some(lan)));
        assert!(!bound.is_trusted_host_from("localhost:3000", Some(lan)));
        // Listing localhost itself opts in (a container's port mapping).
        let mapped = DevHostPolicy::new("0.0.0.0", &["localhost".to_string()]);
        assert!(mapped.is_trusted_host_from("localhost:3000", Some(lan)));
    }

    #[test]
    fn untrusted_host_message_explains_the_fix() {
        let msg = DevGuardRejection::UntrustedHost("myvm.local:3000".into()).message();
        assert!(msg.contains("[dev]"));
        assert!(msg.contains("allowed_hosts"));
        assert!(msg.contains("myvm.local:3000"));
    }

    #[test]
    fn page_ignores_provenance_headers() {
        // A link to the dashboard from another site is a harmless navigation.
        assert!(policy()
            .check(
                DevEndpointKind::Page,
                Some("localhost:3000"),
                Some("https://evil.example"),
                Some("cross-site"),
            )
            .is_ok());
    }

    #[test]
    fn read_endpoints_reject_cross_site_and_foreign_origin() {
        let p = policy();
        let host = Some("localhost:3000");
        assert!(p.check(DevEndpointKind::Read, host, None, None).is_ok());
        assert!(p
            .check(DevEndpointKind::Read, host, None, Some("same-origin"))
            .is_ok());
        assert!(p
            .check(DevEndpointKind::Read, host, None, Some("same-site"))
            .is_ok());
        assert!(p
            .check(
                DevEndpointKind::Read,
                host,
                Some("http://localhost:3000"),
                Some("same-origin")
            )
            .is_ok());
        assert_eq!(
            p.check(DevEndpointKind::Read, host, None, Some("cross-site")),
            Err(DevGuardRejection::CrossSite("cross-site".into()))
        );
        assert_eq!(
            p.check(
                DevEndpointKind::Read,
                host,
                Some("http://evil.example"),
                None
            ),
            Err(DevGuardRejection::ForeignOrigin(
                "http://evil.example".into()
            ))
        );
    }

    #[test]
    fn privileged_endpoint_requires_same_origin() {
        let p = policy();
        let host = Some("127.0.0.1:3000");
        // curl / non-browser clients send neither header.
        assert!(p
            .check(DevEndpointKind::Privileged, host, None, None)
            .is_ok());
        assert!(p
            .check(
                DevEndpointKind::Privileged,
                host,
                Some("http://127.0.0.1:3000"),
                Some("same-origin")
            )
            .is_ok());
        assert!(p
            .check(DevEndpointKind::Privileged, host, None, Some("none"))
            .is_ok());
        for site in ["same-site", "cross-site"] {
            assert_eq!(
                p.check(DevEndpointKind::Privileged, host, None, Some(site)),
                Err(DevGuardRejection::CrossSite(site.into()))
            );
        }
        // Another localhost port is a different origin.
        assert!(p
            .check(
                DevEndpointKind::Privileged,
                host,
                Some("http://127.0.0.1:8080"),
                None
            )
            .is_err());
        assert!(p
            .check(DevEndpointKind::Privileged, host, Some("null"), None)
            .is_err());
    }

    #[test]
    fn allowed_host_origin_is_accepted_behind_a_port_forwarder() {
        let p = DevHostPolicy::new("0.0.0.0", &["dev.tunnel.example".to_string()]);
        assert!(p
            .check(
                DevEndpointKind::Privileged,
                Some("localhost:3000"),
                Some("https://dev.tunnel.example"),
                Some("same-origin"),
            )
            .is_ok());
        assert!(p
            .check(
                DevEndpointKind::Privileged,
                Some("localhost:3000"),
                Some("https://evil.example"),
                Some("same-origin"),
            )
            .is_err());
    }

    #[test]
    fn endpoint_kinds_are_classified_by_path() {
        assert_eq!(
            DevEndpointKind::for_path("/_gio/devtools"),
            DevEndpointKind::Page
        );
        assert_eq!(
            DevEndpointKind::for_path("/_gio/devtools/open-in-editor"),
            DevEndpointKind::Privileged
        );
        for path in [
            "/_gio/devtools/state",
            "/_gio/devtools/stream",
            "/_gio/devtools/codeframe",
        ] {
            assert_eq!(DevEndpointKind::for_path(path), DevEndpointKind::Read);
        }
    }
}
