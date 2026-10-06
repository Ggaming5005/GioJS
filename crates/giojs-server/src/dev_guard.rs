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
//! here; that threat is addressed by binding to 127.0.0.1, not by this module.

use std::net::IpAddr;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevGuardRejection {
    MissingHost,
    UntrustedHost(String),
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
            Self::CrossSite(site) => format!(
                "GioJS dev endpoints refuse requests with Sec-Fetch-Site: {site}; \
                 call them from a page served by this dev server.\n"
            ),
            Self::ForeignOrigin(origin) => format!(
                "GioJS dev endpoints refuse requests from origin \"{origin}\"; \
                 call them from a page served by this dev server.\n"
            ),
        }
    }
}

/// Hosts the dev endpoints answer to, normalized to lowercase hostnames
/// without port or IPv6 brackets.
#[derive(Debug, Clone, Default)]
pub struct DevHostPolicy {
    /// The bind address when it names one interface (not 0.0.0.0 / ::).
    bind_host: Option<String>,
    /// `[dev] allowed_hosts`. Entries starting with `.` match subdomains.
    allowed_hosts: Vec<String>,
}

impl DevHostPolicy {
    pub fn new(bind_host: &str, allowed_hosts: &[String]) -> Self {
        let bind_host = normalize_hostname(bind_host)
            .filter(|host| !host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()));
        let allowed_hosts = allowed_hosts
            .iter()
            .filter_map(|entry| {
                let entry = entry.trim();
                match entry.strip_prefix('.') {
                    Some(suffix) => normalize_hostname(suffix).map(|s| format!(".{s}")),
                    None => normalize_hostname(entry),
                }
            })
            .collect();
        Self {
            bind_host,
            allowed_hosts,
        }
    }

    /// Whether a Host header value (`name[:port]`) is trusted.
    pub fn is_trusted_host(&self, host_header: &str) -> bool {
        normalize_hostname(host_header).is_some_and(|host| self.is_trusted_hostname(&host))
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

    /// Vet one dev endpoint request. `host` is the Host header (or the
    /// HTTP/2 :authority); `origin` and `sec_fetch_site` are the raw headers.
    pub fn check(
        &self,
        kind: DevEndpointKind,
        host: Option<&str>,
        origin: Option<&str>,
        sec_fetch_site: Option<&str>,
    ) -> Result<(), DevGuardRejection> {
        let host = host
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .ok_or(DevGuardRejection::MissingHost)?;
        if !self.is_trusted_host(host) {
            return Err(DevGuardRejection::UntrustedHost(host.to_string()));
        }
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
        let Some((_, authority)) = origin.split_once("://") else {
            return false;
        };
        let authority = authority.trim_end_matches('/');
        if authority.eq_ignore_ascii_case(host) {
            return true;
        }
        normalize_hostname(authority).is_some_and(|h| self.is_explicitly_allowed(&h))
    }

    pub fn allowed_hosts(&self) -> &[String] {
        &self.allowed_hosts
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
    if host.is_empty() || host.contains(['/', '@', ' ', '\\']) {
        return None;
    }
    Some(host)
}

fn is_port(s: &str) -> bool {
    !s.is_empty() && s.len() <= 5 && s.bytes().all(|b| b.is_ascii_digit())
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
